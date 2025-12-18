require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const axios = require("axios");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const bcrypt = require("bcrypt");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3000;

// =====================
// ENV
// =====================
const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  "150394320903-79ve7o5v80r87l4ko8807hq3erjlprc3.apps.googleusercontent.com";

const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.ENV_GEMINI_API_KEY;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// =====================
// MongoDB Models
// =====================

// Users
const UserSchema = new mongoose.Schema(
  {
    googleId: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    password: { type: String },
    // مهم: جوجل ممكن يجي بدون username بالبداية
    username: { type: String, default: null },
    wins: { type: Number, default: 0 },
    totalScore: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);

// Rooms
const RoomSchema = new mongoose.Schema({
  roomCode: { type: String, unique: true, required: true },

  creatorName: { type: String, required: true },
  creatorId: { type: String, required: true },

  players: { type: Array, default: [] },

  settings: {
    type: Object,
    default: { rounds: 5, time: 90, currentRound: 0 },
  },

  currentLetter: { type: String, default: "" },
  usedLetters: { type: Array, default: [] },

  // لمنع أكثر من لاعب يوقف بنفس الجولة
  gameStopped: { type: Boolean, default: false },

  // (اختياري) حالة اللعبة
  gameState: {
    type: String,
    enum: ["waiting", "playing"],
    default: "waiting",
  },

  createdAt: { type: Date, default: Date.now }, // بدون expires أثناء التطوير
});

const Room = mongoose.model("Room", RoomSchema);

// =====================
// Helpers
// =====================
const AVAILABLE_LETTERS = [
  "أ", "ب", "ت", "ج", "ح", "خ", "د", "ر", "ز", "س", "ش",
  "ص", "ط", "ع", "غ", "ف", "ق", "ك", "ل", "م", "ن", "ه", "و", "ي"
];

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function selectRandomLetter(usedLetters) {
  const remaining = AVAILABLE_LETTERS.filter((l) => !usedLetters.includes(l));
  if (remaining.length === 0) return null;
  return remaining[Math.floor(Math.random() * remaining.length)];
}

async function verifyGoogleToken(token) {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    return ticket.getPayload();
  } catch (e) {
    return null;
  }
}

async function validateAnswersWithAI(answers, letter) {
  if (!GEMINI_API_KEY) return null;

  const prompt = `
أنت حكم في لعبة "إنسان حيوان جماد نبات بلاد اسم".
الحرف المطلوب هو "${letter}".
قيم الإجابات التالية بدقة.

أرجع JSON فقط بهذا الشكل (بدون شرح):
{
 "حيوان": "صح/خطأ",
 "جماد": "صح/خطأ",
 "نبات": "صح/خطأ",
 "بلاد": "صح/خطأ",
 "اسم": "صح/خطأ"
}

الشروط:
- الكلمة تبدأ بحرف "${letter}"
- وتكون صحيحة وتنتمي للفئة فعلاً

الإجابات:
${JSON.stringify(answers)}
  `.trim();

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    // محاولة استخراج JSON لو Gemini زاد نص
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start === -1 || end === -1) return null;

    const jsonStr = clean.slice(start, end + 1);
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("AI Error:", error?.response?.data || error.message);
    return null;
  }
}

// =====================
// Express
// =====================
app.use(express.static(path.join(__dirname)));

// =====================
// Mongo Connect
// =====================
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI غير موجود في .env");
} else {
  mongoose
    .connect(MONGODB_URI)
    .then(() => console.log("✅ متصل بقاعدة بيانات MongoDB"))
    .catch((err) => console.error("❌ فشل الاتصال بـ MongoDB:", err));
}

// =====================
// Socket.io
// =====================
io.on("connection", (socket) => {
  console.log(`👤 لاعب متصل: ${socket.id}`);

  // ---------------------
  // Auth
  // ---------------------
  socket.on("google_login", async (data) => {
    const payload = await verifyGoogleToken(data.token);
    if (!payload) return socket.emit("auth_error", { message: "رمز جوجل غير صالح" });

    try {
      let user = await User.findOne({ googleId: payload.sub });

      if (!user) {
        user = new User({
          googleId: payload.sub,
          email: payload.email,
          username: null,
        });
        await user.save();
      }

      socket.emit("auth_success", {
        username: user.username,
        wins: user.wins,
        email: user.email,
      });
    } catch (e) {
      socket.emit("auth_error", { message: "خطأ قاعدة بيانات" });
    }
  });

  socket.on("register_request", async (data) => {
    try {
      const { email, password, username } = data;

      if (!email || !password || !username) {
        return socket.emit("auth_error", { message: "أكمل البيانات" });
      }

      const existingUser = await User.findOne({ email });
      if (existingUser) return socket.emit("auth_error", { message: "البريد مستخدم!" });

      const existingName = await User.findOne({ username });
      if (existingName) return socket.emit("auth_error", { message: "اسم المستخدم مأخوذ!" });

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = new User({ email, password: hashedPassword, username });
      await newUser.save();

      socket.emit("auth_success", {
        username: newUser.username,
        wins: newUser.wins,
        email: newUser.email,
      });
    } catch (e) {
      socket.emit("auth_error", { message: "فشل الإنشاء" });
    }
  });

  socket.on("login_request", async (data) => {
    try {
      const user = await User.findOne({ email: data.email });
      if (!user || !user.password) return socket.emit("auth_error", { message: "بيانات خاطئة" });

      const isMatch = await bcrypt.compare(data.password, user.password);
      if (!isMatch) return socket.emit("auth_error", { message: "كلمة السر خطأ" });

      socket.emit("auth_success", {
        username: user.username,
        wins: user.wins,
        email: user.email,
      });
    } catch (e) {
      socket.emit("auth_error", { message: "فشل الدخول" });
    }
  });

  socket.on("update_initial_username", async (data) => {
    try {
      const { email, newUsername } = data;
      if (!email || !newUsername) return;

      const existingName = await User.findOne({ username: newUsername });
      if (existingName) {
        return socket.emit("auth_error", { message: "هذا الاسم مأخوذ بالفعل، اختر غيره" });
      }

      const updatedUser = await User.findOneAndUpdate(
        { email },
        { username: newUsername },
        { new: true }
      );

      if (updatedUser) {
        socket.emit("username_updated", { username: updatedUser.username });
      }
    } catch (e) {
      socket.emit("auth_error", { message: "حدث خطأ أثناء حفظ الاسم" });
    }
  });

  // ---------------------
  // Rooms
  // ---------------------
  socket.on("create_room_request", async (data) => {
    try {
      const playerName = (data.playerName || "").trim();
      if (!playerName) {
        return socket.emit("room_error", { message: "اسم اللاعب غير موجود" });
      }

      // تأكد ما يصير تضارب في الكود
      let roomCode = generateRoomCode();
      while (await Room.findOne({ roomCode })) {
        roomCode = generateRoomCode();
      }

      const newRoom = new Room({
        roomCode,
        creatorName: playerName,
        creatorId: socket.id,
        players: [
          { id: socket.id, name: playerName, role: "منشئ المجموعة", wins: 0, score: 0 },
        ],
        settings: { rounds: 5, time: 90, currentRound: 0 },
      });

      await newRoom.save();

      socket.join(roomCode);
      socket.emit("room_created", { roomCode });

      // ابعث معلومات الغرفة فورًا
      io.to(roomCode).emit("room_info", {
        players: newRoom.players,
        creatorId: newRoom.creatorId,
        settings: newRoom.settings,
      });

      console.log(`✅ تم إنشاء الغرفة وحفظها: ${roomCode}`);
    } catch (e) {
      console.error("❌ خطأ إنشاء غرفة:", e);
      socket.emit("room_error", { message: "حدث خطأ أثناء إنشاء الغرفة" });
    }
  });

  socket.on("join_room_request", async (data) => {
    const roomCode = String(data.roomCode || "").trim();
    const playerName = String(data.playerName || "").trim();

    try {
      if (!roomCode || roomCode.length !== 6) {
        return socket.emit("room_error", { message: "رمز الغرفة غير صحيح" });
      }
      if (!playerName) {
        return socket.emit("room_error", { message: "اسم اللاعب غير موجود" });
      }

      const room = await Room.findOne({ roomCode });
      if (!room) {
        return socket.emit("room_error", {
          message: `عذراً، الغرفة رقم (${roomCode}) غير موجودة حالياً.`,
        });
      }

      // منع الانضمام بعد بدء اللعب (اختياري)
      if (room.gameState === "playing") {
        return socket.emit("room_error", { message: "المباراة بدأت بالفعل، لا يمكن الانضمام الآن." });
      }

      socket.join(roomCode);

      // wins من قاعدة البيانات (لو موجود)
      const userDb = await User.findOne({ username: playerName });
      const wins = userDb ? userDb.wins : 0;

      // لا تكرر نفس الاسم
      if (!room.players.find((p) => p.name === playerName)) {
        room.players.push({ id: socket.id, name: playerName, role: "عضو", wins, score: 0 });
        await room.save();
      }

      socket.emit("room_joined", { roomCode });

      io.to(roomCode).emit("room_info", {
        players: room.players,
        creatorId: room.creatorId,
        settings: room.settings,
      });

      console.log(`✅ انضم ${playerName} إلى الغرفة ${roomCode}`);
    } catch (e) {
      console.error("❌ خطأ انضمام:", e);
      socket.emit("room_error", { message: "حدث خطأ أثناء الانضمام" });
    }
  });

  // هذا الحدث تستخدمه waiting.html (وأيضًا game.html بعد تعديل بسيط)
  socket.on("identify_player", async (data) => {
    try {
      const roomCode = String(data.roomCode || "").trim();
      const playerName = String(data.playerName || "").trim();
      if (!roomCode || !playerName) return;

      const room = await Room.findOne({ roomCode });
      if (!room) return;

      // wins من DB
      const userDb = await User.findOne({ username: playerName });
      const wins = userDb ? userDb.wins : 0;

      let player = room.players.find((p) => p.name === playerName);

      const isCreatorByName = playerName === room.creatorName;
      const role = isCreatorByName ? "منشئ المجموعة" : "عضو";

      if (!player) {
        player = { id: socket.id, name: playerName, role, wins, score: 0 };
        room.players.push(player);
      } else {
        player.id = socket.id; // تحديث socket.id عند refresh
        if (isCreatorByName) player.role = "منشئ المجموعة";
        player.wins = wins;
      }

      // تأكد creatorId صحيح (لو المنشئ عمل ريفرش)
      if (isCreatorByName) {
        room.creatorId = socket.id;
      }

      await room.save();
      socket.join(roomCode);

      io.to(roomCode).emit("room_info", {
        players: room.players,
        creatorId: room.creatorId,
        settings: room.settings,
      });

      console.log(`✅ identify_player: ${playerName} في الغرفة ${roomCode}`);
    } catch (e) {
      console.error("❌ identify_player error:", e);
    }
  });

  // ---------------------
  // Permissions Actions
  // ---------------------

  // طرد لاعب (MongoDB only)
  socket.on("kick_player", async (data) => {
    try {
      const roomCode = String(data.roomCode || "").trim();
      const targetId = String(data.targetId || "").trim();

      const room = await Room.findOne({ roomCode });
      if (!room) return;

      // صلاحية: فقط المنشئ
      if (room.creatorId !== socket.id) return;

      // لا تطرد نفسك
      if (targetId === room.creatorId) return;

      room.players = room.players.filter((p) => p.id !== targetId);
      await room.save();

      io.to(roomCode).emit("room_info", {
        players: room.players,
        creatorId: room.creatorId,
        settings: room.settings,
      });

      io.to(targetId).emit("you_are_kicked");

      console.log(`🧹 تم طرد لاعب من الغرفة ${roomCode}`);
    } catch (e) {
      console.error("❌ kick_player error:", e);
    }
  });

  // حفظ إعدادات (MongoDB only)
  socket.on("update_settings", async (data) => {
    try {
      const roomCode = String(data.roomCode || "").trim();
      const rounds = Number(data.rounds);
      const time = Number(data.time);

      const room = await Room.findOne({ roomCode });
      if (!room) return;

      // صلاحية: فقط المنشئ
      if (room.creatorId !== socket.id) return;

      // قيود بسيطة
      room.settings.rounds = Math.max(1, Math.min(10, rounds || 5));
      room.settings.time = Math.max(30, Math.min(180, time || 90));

      await room.save();

      io.to(roomCode).emit("room_info", {
        players: room.players,
        creatorId: room.creatorId,
        settings: room.settings,
      });

      console.log(`⚙️ تحديث إعدادات الغرفة ${roomCode}`);
    } catch (e) {
      console.error("❌ update_settings error:", e);
    }
  });

  // بدء اللعبة (MongoDB only)
  socket.on("start_game", async (data) => {
    try {
      const roomCode = String(data.roomCode || "").trim();
      const playerName = String(data.playerName || "").trim(); // مهم من الواجهة

      const room = await Room.findOne({ roomCode });
      if (!room) return;

      // صلاحية: المنشئ فقط (بـ id أو الاسم كدعم)
      const isCreator = room.creatorId === socket.id || playerName === room.creatorName;
      if (!isCreator) return;

      // امنع البدء مرتين
      if (room.gameState === "playing") return;

      // جهّز جولة جديدة
      room.gameStopped = false;
      room.gameState = "playing";

      // عداد جولات
      if (!room.settings.currentRound) room.settings.currentRound = 0;

      // العد التنازلي
      let count = 3;
      const interval = setInterval(async () => {
        io.to(roomCode).emit("pre_game_countdown", count);

        if (count === 0) {
          clearInterval(interval);

          // اختر حرف
          const nextLetter = selectRandomLetter(room.usedLetters);
          if (!nextLetter) {
            // انتهت الحروف (نادراً)
            room.gameState = "waiting";
            await room.save();
            io.to(roomCode).emit("room_error", { message: "انتهت الحروف المتاحة!" });
            return;
          }

          room.currentLetter = nextLetter;
          room.usedLetters.push(nextLetter);
          room.settings.currentRound += 1;

          await room.save();

          io.to(roomCode).emit("game_actually_started", {
            letter: nextLetter,
            time: room.settings.time,
            round: room.settings.currentRound,
          });

          console.log(`🎮 بدأت الجولة ${room.settings.currentRound} للحرف ${nextLetter} في الغرفة ${roomCode}`);
        }

        count--;
      }, 1000);
    } catch (e) {
      console.error("❌ start_game error:", e);
    }
  });

  // زر "توقف" من game.html
  socket.on("stop_game_request", async (data) => {
    try {
      const roomCode = String(data.roomCode || "").trim();
      const playerName = String(data.playerName || "").trim();
      const answers = data.answers || {};
      const currentLetter = String(data.currentLetter || "").trim();

      const room = await Room.findOne({ roomCode });
      if (!room) return socket.emit("stop_failed", { message: "الغرفة غير موجودة" });

      // امنع أكثر من توقيف
      if (room.gameStopped) {
        return socket.emit("stop_failed", { message: "تم إيقاف الجولة بالفعل!" });
      }

      // حرف الأمان: لازم يطابق حرف الغرفة
      if (room.currentLetter && currentLetter && room.currentLetter !== currentLetter) {
        return socket.emit("stop_failed", { message: "حرف الجولة غير مطابق!" });
      }

      room.gameStopped = true;
      room.gameState = "waiting";
      await room.save();

      // شغّل Gemini
      const result = await validateAnswersWithAI(answers, room.currentLetter || currentLetter);

      if (!result) {
        // لو فشل الذكاء
        io.to(roomCode).emit("ai_correction", {
          حيوان: "خطأ",
          جماد: "خطأ",
          نبات: "خطأ",
          بلاد: "خطأ",
          اسم: "خطأ",
        });
        io.to(roomCode).emit("player_won_match", { winner: playerName });
        return;
      }

      // ابعث التصحيح للجميع
      io.to(roomCode).emit("ai_correction", result);

      // إعلان الفائز (حسب طلبك الحالي: أول من يوقف هو الفائز)
      io.to(roomCode).emit("player_won_match", { winner: playerName });

      // تحديث wins
      await User.findOneAndUpdate({ username: playerName }, { $inc: { wins: 1 } });

      console.log(`🏁 stop_game_request: الفائز ${playerName} في الغرفة ${roomCode}`);
    } catch (e) {
      console.error("❌ stop_game_request error:", e);
      socket.emit("stop_failed", { message: "حدث خطأ أثناء التحقق" });
    }
  });

  // ---------------------
  // Disconnect
  // ---------------------
  socket.on("disconnect", async () => {
    try {
      const room = await Room.findOne({ "players.id": socket.id });
      if (!room) return;

      const roomCode = room.roomCode;
      const updatedPlayers = room.players.filter((p) => p.id !== socket.id);

      if (updatedPlayers.length === 0) {
        await Room.deleteOne({ roomCode });
        console.log(`🗑️ تم حذف الغرفة الفارغة: ${roomCode}`);
        return;
      }

      // نقل القيادة إذا خرج المنشئ
      if (socket.id === room.creatorId) {
        const nextLeader = updatedPlayers[0];
        room.creatorId = nextLeader.id;
        room.creatorName = nextLeader.name;

        // حدّث الأدوار
        updatedPlayers.forEach((p) => (p.role = "عضو"));
        nextLeader.role = "منشئ المجموعة";

        console.log(`👑 انتقلت القيادة إلى: ${room.creatorName}`);
      }

      room.players = updatedPlayers;
      await room.save();

      io.to(roomCode).emit("room_info", {
        players: room.players,
        creatorId: room.creatorId,
        settings: room.settings,
      });
    } catch (e) {
      console.error("❌ disconnect error:", e);
    }
  });
});

// =====================
// Listen
// =====================
server.listen(PORT, () => {
  console.log(`✅ الخادم يعمل على المنفذ: ${PORT}`);
});
