require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const axios = require('axios'); 
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// إعدادات البيئة
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "150394320903-79ve7o5v80r87l4ko8807hq3erjlprc3.apps.googleusercontent.com"; 
const MONGODB_URI = process.env.MONGODB_URI; 
const client = new OAuth2Client(GOOGLE_CLIENT_ID);
const GEMINI_API_KEY = process.env.ENV_GEMINI_API_KEY; 

// تعريف Schema المستخدم
const UserSchema = new mongoose.Schema({
    googleId: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    password: { type: String },
    username: { type: String, required: true },
    wins: { type: Number, default: 0 },
    totalScore: { type: Number, default: 0 },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);
// --- إضافة نموذج الغرفة هنا لضمان بقائها في قاعدة البيانات ---

const RoomSchema = new mongoose.Schema({
    roomCode: { type: String, unique: true, required: true },
    creatorName: { type: String, required: true }, // أضف هذا السطر لحفظ اسم المنشئ
    creatorId: { type: String, required: true },
    // ... بقية الكود كما هو
    players: { type: Array, default: [] },
    settings: { type: Object, default: { rounds: 5, time: 90, currentRound: 0 } },
    currentLetter: { type: String, default: "" },
    usedLetters: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now, expires: 7200 } // حذف الغرفة تلقائياً بعد ساعتين
});

const Room = mongoose.model('Room', RoomSchema);

async function validateWithAI(answers, letter) {
    const prompt = `أنت حكم في لعبة "إنسان حيوان جماد". الحرف هو "${letter}". 
    قيم الإجابات التالية وأجب بكلمة "صح" أو "خطأ" فقط لكل فئة بتنسيق JSON:
    ${JSON.stringify(answers)}. تأكد أن الكلمة تبدأ بالحرف وأنها تنتمي للفئة فعلاً.`;

    try {
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.ENV_GEMINI_API_KEY}`, {
            contents: [{ parts: [{ text: prompt }] }]
        });
        const text = response.data.candidates[0].content.parts[0].text;
        return JSON.parse(text.replace(/```json|```/g, ""));
    } catch (e) { return null; }
}
// ---------------------------------------------------------
// الاتصال بقاعدة البيانات
mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ متصل بقاعدة بيانات MongoDB"))
    .catch(err => console.error("❌ فشل الاتصال بقاعدة بيانات MongoDB:", err));

// دالة التحقق من توكن جوجل
async function verifyGoogleToken(token) {
    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });
        return ticket.getPayload();
    } catch (error) { return null; }
}

const activeRooms = {}; 
const AVAILABLE_LETTERS = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'ز', 'س', 'ش', 'ص', 'ط', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'];

function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function selectRandomLetter(usedLetters) {
    const remainingLetters = AVAILABLE_LETTERS.filter(letter => !usedLetters.includes(letter));
    return remainingLetters.length === 0 ? null : remainingLetters[Math.floor(Math.random() * remainingLetters.length)];
}

app.use(express.static(path.join(__dirname)));

// دالة التحقق من الإجابات باستخدام Gemini AI
async function validateAnswersWithAI(answers, letter) {
    const prompt = `أنت حكم في لعبة "إنسان حيوان جماد". الحرف المطلوب هو "${letter}". 
    قيم الإجابات التالية بدقة وأجب بكلمة "صح" أو "خطأ" فقط لكل فئة بتنسيق JSON:
    ${JSON.stringify(answers)}. 
    شروط الفوز: يجب أن تبدأ الكلمة بحرف "${letter}" وتكون صحيحة لغوياً وفي فئتها.`;

    try {
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.ENV_GEMINI_API_KEY}`, {
            contents: [{ parts: [{ text: prompt }] }]
        });
        const resultText = response.data.candidates[0].content.parts[0].text;
        return JSON.parse(resultText.replace(/```json|```/g, "").trim());
    } catch (error) {
        console.error("AI Error:", error);
        return null;
    }
}

// ******************************************************
// ** Socket Events **
// ******************************************************
io.on('connection', (socket) => {
    console.log(`👤 لاعب متصل: ${socket.id}`);

  // --- 1. تسجيل الدخول (جوجل) ---
    socket.on('google_login', async (data) => {
        const payload = await verifyGoogleToken(data.token);
        if (!payload) return socket.emit('auth_error', { message: 'رمز غير صالح' });
        try {
            let user = await User.findOne({ googleId: payload.sub });
            if (!user) {
                user = new User({ 
                    googleId: payload.sub, 
                    email: payload.email, 
                    username: null 
                });
                await user.save();
            }
            socket.emit('auth_success', { 
                username: user.username, 
                wins: user.wins, 
                email: user.email 
            });
        } catch (error) { socket.emit('auth_error', { message: 'خطأ قاعدة بيانات' }); }
    });

    // --- 2. إنشاء حساب يدوي ---
    socket.on('register_request', async (data) => {
        try {
            const { email, password, username } = data;
            const existingUser = await User.findOne({ email });
            if (existingUser) return socket.emit('auth_error', { message: 'البريد مستخدم!' });
            const hashedPassword = await bcrypt.hash(password, 10);
            const newUser = new User({ email, password: hashedPassword, username });
            await newUser.save();
            socket.emit('auth_success', { 
                username: newUser.username, 
                wins: 0, 
                email: newUser.email 
            });
        } catch (error) { socket.emit('auth_error', { message: 'فشل الإنشاء' }); }
    });

    // --- 3. تسجيل دخول يدوي ---
    socket.on('login_request', async (data) => {
        try {
            const user = await User.findOne({ email: data.email });
            if (!user || !user.password) return socket.emit('auth_error', { message: 'بيانات خاطئة' });
            const isMatch = await bcrypt.compare(data.password, user.password);
            if (!isMatch) return socket.emit('auth_error', { message: 'كلمة سر خطأ' });
            
            socket.emit('auth_success', { 
                username: user.username, 
                wins: user.wins, 
                email: user.email 
            });
        } catch (error) { socket.emit('auth_error', { message: 'فشل الدخول' }); }
    });

    // --- 4. تحديث اسم الشهرة لأول مرة ---
    socket.on('update_initial_username', async (data) => {
        try {
            const { email, newUsername } = data;
            const existingName = await User.findOne({ username: newUsername });
            if (existingName) return socket.emit('auth_error', { message: 'هذا الاسم مأخوذ بالفعل، اختر غيره' });

            const updatedUser = await User.findOneAndUpdate(
                { email: email },
                { username: newUsername },
                { new: true }
            );
            if (updatedUser) {
                socket.emit('username_updated', { username: updatedUser.username });
            }
        } catch (error) { 
            socket.emit('auth_error', { message: 'حدث خطأ أثناء حفظ الاسم' }); 
        }
    });

const newRoom = new Room({
    roomCode: roomCode,
    creatorName: data.playerName, // حفظ اسمك كمنشئ دائم
    creatorId: socket.id,
    players: [{ id: socket.id, name: data.playerName, role: 'منشئ المجموعة', wins: 0, score: 0 }],
    settings: { rounds: 5, time: 90, currentRound: 0 }
});
  socket.on('join_room_request', async (data) => {
    const roomCode = String(data.roomCode).trim();
    try {
        // البحث عن الغرفة في قاعدة البيانات
        const room = await Room.findOne({ roomCode: roomCode });

        if (room) {
            socket.join(roomCode);
            const userDb = await User.findOne({ username: data.playerName });
            
            if (!room.players.find(p => p.name === data.playerName)) {
                room.players.push({ id: socket.id, name: data.playerName, wins: userDb ? userDb.wins : 0, score: 0 });
                await Room.updateOne({ roomCode: roomCode }, { players: room.players });
            }

            socket.emit('room_joined', { roomCode: roomCode });
            io.to(roomCode).emit('room_info', { 
                players: room.players, 
                creatorId: room.creatorId, 
                settings: room.settings 
            });
        } else {
            socket.emit('room_error', { message: `عذراً، الغرفة رقم (${roomCode}) غير موجودة حالياً.` });
        }
    } catch (error) {
        socket.emit('room_error', { message: "حدث خطأ أثناء الانضمام" });
    }
});
    // --- تعريف الهوية في الانتظار (تم توحيدها وتعديلها) ---
 socket.on('identify_player', async (data) => {
    try {
        const roomCode = String(data.roomCode).trim();
        // 1. البحث عن الغرفة في MongoDB لضمان وجود البيانات
        const room = await Room.findOne({ roomCode: roomCode });
        
        if (room) {
            const userDb = await User.findOne({ username: data.playerName });
            const wins = userDb ? userDb.wins : 0;

            // 2. تحديث معرف السوكت (socket.id) للاعب والبحث عنه في القائمة
            let player = room.players.find(p => p.name === data.playerName);
            
            // تحديد الدور: إذا كان هو من أنشأ الغرفة يأخذ لقب منشئ
           // التحقق من الدور بناءً على الاسم المخزن أو إذا كانت القائمة فارغة
const isCreator = (data.playerName === room.creatorName || room.players.length === 0);
const role = isCreator ? 'منشئ المجموعة' : 'عضو';
            if (!player) {
                // إضافة لاعب جديد مع دوره
                player = { id: socket.id, name: data.playerName, role: role, wins: wins, score: 0 };
                room.players.push(player);
            } else {
                // تحديث الـ ID فقط إذا كان اللاعب موجوداً مسبقاً (عند عمل ريفرش)
                player.id = socket.id;
            }

            // 3. حفظ التعديلات في قاعدة البيانات
            await Room.updateOne({ roomCode: roomCode }, { players: room.players });
            socket.join(roomCode);

            // 4. إرسال الحدث السحري لظهور الأسماء فوراً
            io.to(roomCode).emit('room_info', { 
                players: room.players, 
                creatorId: room.creatorId, 
                settings: room.settings 
            });

            console.log(`✅ اللاعب ${data.playerName} (${role}) متواجد الآن في الغرفة ${roomCode}`);
        }
    } catch (error) {
        console.error("❌ خطأ في identify_player:", error);
    }
});

    // --- طرد لاعب ---
    socket.on('kick_player', (data) => {
        const room = activeRooms[data.roomCode];
        if (room && room.creatorId === socket.id) {
            io.to(data.targetId).emit('you_are_kicked');
            room.players = room.players.filter(p => p.id !== data.targetId);
            io.to(data.roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
        }
    });

    // --- تحديث الفوز ---
    socket.on('update_winner_score', async (data) => {
        try {
            await User.findOneAndUpdate({ username: data.playerName }, { $inc: { wins: 1 } });
        } catch (e) { console.log("خطأ تحديث فوز"); }
    });

  socket.on('disconnect', async () => {
    try {
        // البحث عن أي غرفة كان يتواجد بها هذا اللاعب
        const room = await Room.findOne({ "players.id": socket.id });
        
        if (room) {
            // حذف اللاعب من القائمة
            const updatedPlayers = room.players.filter(p => p.id !== socket.id);
            
            if (updatedPlayers.length === 0) {
                // إذا لم يتبق أحد، نحذف الغرفة نهائياً
                await Room.deleteOne({ roomCode: room.roomCode });
                console.log(`🗑️ تم حذف الغرفة الفارغة: ${room.roomCode}`);
            } else {
                let newCreatorId = room.creatorId;
                let newCreatorName = room.creatorName;

                // إذا كان اللاعب المغادر هو المنشئ، ننقل الصلاحية لأول لاعب متبقي
                if (socket.id === room.creatorId) {
                    const nextLeader = updatedPlayers[0];
                    newCreatorId = nextLeader.id;
                    newCreatorName = nextLeader.name;
                    nextLeader.role = 'منشئ المجموعة'; // تحديث دور القائد الجديد
                    console.log(`👑 انتقلت القيادة إلى: ${newCreatorName}`);
                }

                // حفظ التغييرات في قاعدة البيانات
                await Room.updateOne(
                    { roomCode: room.roomCode },
                    { 
                        players: updatedPlayers, 
                        creatorId: newCreatorId, 
                        creatorName: newCreatorName 
                    }
                );

                // إبلاغ الجميع في الغرفة بالمنشئ الجديد وقائمة اللاعبين المحدثة
                io.to(room.roomCode).emit('room_info', { 
                    players: updatedPlayers, 
                    creatorId: newCreatorId, 
                    settings: room.settings 
                });
                
                io.to(room.roomCode).emit('system_message', { 
                    message: `🚪 غادر اللاعب وتبدلت القيادة!`, 
                    color: '#e74c3c' 
                });
            }
        }
    } catch (error) {
        console.error("خطأ أثناء الخروج:", error);
    }
});

    // --- إعدادات المباراة وبدء اللعب ---
    socket.on('update_settings', (data) => {
        const room = activeRooms[data.roomCode];
       // السطر 342 المحدث:
if (room && (room.creatorId === socket.id || data.playerName === room.creatorName)) {
            room.settings.rounds = data.rounds;
            room.settings.time = data.time;
            io.to(data.roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
        }
    });

socket.on('start_game', async (data) => {
    try {
        const room = await Room.findOne({ roomCode: data.roomCode });
       // السماح بالبدء إذا كان الاسم يطابق اسم المنشئ المخزن
if (room && (room.creatorId === socket.id || data.playerName === room.creatorName)) {
            
            // بدلاً من بدء اللعبة فوراً، نرسل عد تنازلي للجميع
            let count = 3;
            const countdownInterval = setInterval(async () => {
                // إرسال الرقم الحالي (3، 2، 1) لكل من في الغرفة
                io.to(data.roomCode).emit('pre_game_countdown', count);
                
                if (count === 0) {
                    clearInterval(countdownInterval);
                    
                    // الآن تبدأ اللعبة فعلياً بعد انتهاء العد
                    const nextLetter = selectRandomLetter(room.usedLetters);
                    if (nextLetter) {
                        room.currentLetter = nextLetter;
                        room.usedLetters.push(nextLetter);
                        room.settings.currentRound += 1;
                        
                        await Room.updateOne({ roomCode: data.roomCode }, { 
                            currentLetter: room.currentLetter,
                            usedLetters: room.usedLetters,
                            settings: room.settings
                        });

                        // إرسال إشارة البدء النهائية مع الحرف المختار
                        io.to(data.roomCode).emit('game_actually_started', { 
                            letter: nextLetter, 
                            time: room.settings.time,
                            round: room.settings.currentRound
                        });
                    }
                }
                count--;
            }, 1000); // يتكرر كل ثانية واحدة
        }
    } catch (error) { console.log("خطأ في بدء اللعبة:", error); }
});
});

server.listen(PORT, () => {
    console.log(`✅ الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});