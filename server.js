require('dotenv').config();
// Start of Server.js
// Final code update for Game Sync, Settings, and Waiting Room

// استدعاء المكتبات المطلوبة
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const axios = require('axios'); 
const mongoose = require('mongoose');
const { OAuth2Client } = require('google-auth-library');
const bcrypt = require('bcrypt'); // <--- إضافة جديدة لتشفير كلمات السر

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // السماح بالاتصال من أي مصدر
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// ******************************************************
// ** مفاتيح المصادقة وقاعدة البيانات (جديد) **
// ******************************************************
const GOOGLE_CLIENT_ID = "150394320903-79ve7o5v80r87l4ko8807hq3erjlprc3.apps.googleusercontent.com"; 
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://1yasmanga_db_user:gy9YP04hVcGyMP7c@cluster0.7tchf9g.mongodb.net/?appName=Cluster0"; 
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// -----------------------------------------------------
// تعريف مخطط (Schema) المستخدمين (محدث ليشمل الانتصارات والحساب اليدوي)
// -----------------------------------------------------
const UserSchema = new mongoose.Schema({
    googleId: { type: String, unique: true, sparse: true }, // sparse تسمح بوجود قيم فارغة لمن لا يستخدم جوجل
    email: { type: String, unique: true, sparse: true },
    password: { type: String },
    username: { type: String, required: true },
    wins: { type: Number, default: 0 }, // تتبع الانتصارات
    totalScore: { type: Number, default: 0 },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

// -----------------------------------------------------
// الاتصال بقاعدة البيانات
// -----------------------------------------------------
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
        const payload = ticket.getPayload();
        return payload;
    } catch (error) {
        console.error("خطأ في التحقق من Google Token:", error);
        return null;
    }
}
// -----------------------------------------------------


// ******************************************************
// ** مفتاح Gemini API الخاص بك **
// ******************************************************
const GEMINI_API_KEY = process.env.ENV_GEMINI_API_KEY || "AIzaSyAi4LC7bmWF3RJq8BaH025NelxAnFzWta8"; 

const activeRooms = {}; 

const AVAILABLE_LETTERS = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'ز', 'س', 'ش', 'ص', 'ط', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'];

// -----------------------------------------------------
// الدوال المساعدة 
// -----------------------------------------------------
function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function selectRandomLetter(usedLetters) {
    const remainingLetters = AVAILABLE_LETTERS.filter(letter => !usedLetters.includes(letter));
    if (remainingLetters.length === 0) {
        return null;
    }
    const randomIndex = Math.floor(Math.random() * remainingLetters.length);
    return remainingLetters[randomIndex];
}

async function checkAnswersWithAI(letter, answers) {
    const prompt = `أنت محكّم خبير للعبة حيوان جماد نبات باللغة العربية. الحرف المطلوب هو: ${letter}. الرجاء تقييم الإجابات.`;
    
    try {
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            contents: [{ parts: [{ text: prompt }] }],
        }, {
            timeout: 8000 
        });

        const aiText = response.data.candidates[0].content.parts[0].text;
        const results = {};
        let isValid = false;
        
        aiText.split('\n').forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.includes('حيوان:')) {
                results.حيوان = trimmedLine.includes('صحيح') ? 'صحيح' : 'خطأ';
                if (results.حيوان === 'صحيح') isValid = true;
            } else if (trimmedLine.includes('جماد:')) {
                results.جماد = trimmedLine.includes('صحيح') ? 'صحيح' : 'خطأ';
                if (results.جماد === 'صحيح') isValid = true;
            } else if (trimmedLine.includes('نبات:')) {
                results.نبات = trimmedLine.includes('صحيح') ? 'صحيح' : 'خطأ';
                if (results.نبات === 'صحيح') isValid = true;
            } else if (trimmedLine.includes('بلاد:')) {
                results.بلاد = trimmedLine.includes('صحيح') ? 'صحيح' : 'خطأ';
                if (results.بلاد === 'صحيح') isValid = true;
            } else if (trimmedLine.includes('اسم:')) {
                results.اسم = trimmedLine.includes('صحيح') ? 'صحيح' : 'خطأ';
                if (results.اسم === 'صحيح') isValid = true;
            }
        });

        return { evaluation: results, success: isValid };

    } catch (error) {
        console.error("خطأ في الاتصال بـ API الذكاء الاصطناعي:", error.response ? error.response.data : error.message);
        return { evaluation: {}, success: false, error: true }; 
    }
}

app.use(express.static(path.join(__dirname)));

io.on('connection', (socket) => {
    console.log(`لاعب جديد متصل: ${socket.id}`);
    
    // --- 8.1 تسجيل الدخول عبر جوجل ---
    socket.on('google_login', async (data) => {
        const payload = await verifyGoogleToken(data.token);
        if (!payload) return socket.emit('auth_error', { message: 'رمز المصادقة غير صالح.' });

        try {
            let user = await User.findOne({ googleId: payload.sub });
            if (!user) {
                user = new User({ googleId: payload.sub, username: payload.name });
                await user.save();
            }
            socket.emit('auth_success', { username: user.username, wins: user.wins });
        } catch (error) {
            socket.emit('auth_error', { message: 'خطأ في قاعدة البيانات.' });
        }
         // حدث طرد لاعب من قبل المنشئ
    socket.on('kick_player', (data) => {
        const { roomCode, targetId } = data;
        const room = activeRooms[roomCode];

        // التأكد أن الذي يطلب الطرد هو منشئ الغرفة
        if (room && room.creatorId === socket.id) {
            // إرسال تنبيه للاعب المطرود ليتم تحويله لصفحة البداية
            io.to(targetId).emit('you_are_kicked');

            // حذف اللاعب من مصفوفة الغرفة
            room.players = room.players.filter(p => p.id !== targetId);

            // تحديث باقي اللاعبين في الغرفة بالقائمة الجديدة
            io.to(roomCode).emit('room_info', {
                players: room.players,
                creatorId: room.creatorId,
                settings: room.settings
            });

            console.log(`🚫 تم طرد لاعب من الغرفة ${roomCode}`);
        }
    });
    });

    // --- 8.2 إنشاء حساب جديد (إضافة جديدة) ---
    socket.on('register_request', async (data) => {
        try {
            const { email, password, username } = data;
            const existingUser = await User.findOne({ email });
            if (existingUser) return socket.emit('auth_error', { message: 'البريد مستخدم بالفعل!' });

            const hashedPassword = await bcrypt.hash(password, 10);
            const newUser = new User({ email, password: hashedPassword, username });
            await newUser.save();
            socket.emit('auth_success', { username: newUser.username, wins: 0 });
        } catch (error) {
            socket.emit('auth_error', { message: 'خطأ في إنشاء الحساب.' });
        }
    });

    // --- 8.3 تسجيل دخول يدوي (إضافة جديدة) ---
    socket.on('login_request', async (data) => {
        try {
            const { email, password } = data;
            const user = await User.findOne({ email });
            if (!user || !user.password) return socket.emit('auth_error', { message: 'البريد أو كلمة السر غير صحيحة!' });

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) return socket.emit('auth_error', { message: 'كلمة السر غير صحيحة!' });

            socket.emit('auth_success', { username: user.username, wins: user.wins });
        } catch (error) {
            socket.emit('auth_error', { message: 'خطأ في تسجيل الدخول.' });
        }
    });

    // حدث تحديث عدد الانتصارات عند فوز لاعب
socket.on('update_winner_score', async (data) => {
    const { playerName } = data;
    try {
        // زيادة عدد الانتصارات (wins) بمقدار 1 في قاعدة البيانات
        const updatedUser = await User.findOneAndUpdate(
            { username: playerName },
            { $inc: { wins: 1 } },
            { new: true }
        );
        console.log(`✅ تم تحديث انتصارات اللاعب ${playerName}: ${updatedUser.wins}`);
    } catch (error) {
        console.error("❌ خطأ في تحديث سجل الفوز:", error);
    }
});

    // --- 1. طلب إنشاء غرفة خاصة (كما هو) ---
    socket.on('create_room_request', (data) => {
        let roomCode = generateRoomCode();
        while (activeRooms[roomCode]) { roomCode = generateRoomCode(); }
        const initialLetter = selectRandomLetter([]); 
        socket.join(roomCode);
        activeRooms[roomCode] = { 
            players: [{ id: socket.id, name: data.playerName, isCreator: true, score: 0 }],
            currentLetter: initialLetter, 
            usedLetters: [initialLetter],
            creatorId: socket.id,
            settings: { rounds: 5, time: 90, currentRound: 0 }
        };
        socket.emit('room_created', { roomCode: roomCode });
        socket.emit('room_info', {
            players: activeRooms[roomCode].players,
            creatorId: activeRooms[roomCode].creatorId,
            settings: activeRooms[roomCode].settings
        });
    });

    // --- 2. طلب الانضمام لغرفة خاصة (كما هو) ---
    socket.on('join_room_request', (data) => {
        const { roomCode, playerName } = data;
        const room = activeRooms[roomCode];
        if (room) {
            socket.join(roomCode);
            room.players.push({ id: socket.id, name: playerName, isCreator: false, score: 0 });
            socket.emit('room_joined', { roomCode: roomCode });
            io.to(roomCode).emit('room_info', {
                players: room.players,
                creatorId: room.creatorId,
                settings: room.settings
            });
        } else {
            socket.emit('room_error', { message: 'رمز الغرفة غير صحيح.' });
        }
    });

    // --- 3. تحديد الهوية (كما هو) ---
   socket.on('identify_player', async (data) => {
    const { roomCode, playerName } = data;
    const room = activeRooms[roomCode];

    if (room) {
        // جلب بيانات اللاعب من قاعدة البيانات لمعرفة عدد انتصاراته
        const userDb = await User.findOne({ username: playerName });
        const userWins = userDb ? userDb.wins : 0;

        let player = room.players.find(p => p.id === socket.id);
        if (!player) {
            player = { 
                id: socket.id, 
                name: playerName, 
                wins: userWins, // إضافة عدد الانتصارات هنا ليراها الآخرون
                score: 0 
            };
            room.players.push(player);
        }

        // إرسال التحديث للجميع
        io.to(roomCode).emit('room_info', {
            players: room.players,
            creatorId: room.creatorId,
            settings: room.settings
        });
    }
});

    // --- 4. تحديث الإعدادات (كما هو) ---
    socket.on('update_settings', (data) => {
        const { roomCode, rounds, time } = data;
        const room = activeRooms[roomCode];
        if (room && room.creatorId === socket.id) {
            room.settings.rounds = Math.max(1, Math.min(10, rounds)); 
            room.settings.time = Math.max(30, Math.min(180, time));
            io.to(roomCode).emit('room_info', {
                players: room.players,
                creatorId: room.creatorId,
                settings: room.settings
            });
        }
    });

    // --- 5. بدء اللعب (كما هو) ---
    socket.on('start_game', (data) => {
        const room = activeRooms[data.roomCode];
        if (room && room.creatorId === socket.id) {
            room.settings.currentRound = 1;
            io.to(data.roomCode).emit('game_started', { 
                roomCode: data.roomCode,
                settings: room.settings 
            });
        }
    });

    // --- 6. طلب الحصول على الحرف (كما هو) ---
    socket.on('get_room_letter', (roomCode) => {
        const room = activeRooms[roomCode];
        if (room && room.currentLetter) {
            socket.emit('room_letter', { 
                currentLetter: room.currentLetter,
                roundTime: room.settings.time 
            });
        }
    });
    
    // --- 7. إيقاف الوقت والتحقق (كما هو) ---
    socket.on('stop_game_request', async (data) => {
        const { roomCode, playerName, answers, currentLetter } = data;
        const { evaluation, success, error } = await checkAnswersWithAI(currentLetter, answers);
        if (error) return socket.emit('stop_failed', { message: 'خطأ فني.' });

        if (success) {
            io.to(roomCode).emit('time_stopped', {
                stopper: playerName,
                answers: answers,
                evaluation: evaluation,
                message: `${playerName} ضغط على زر التوقف!`
            });
        } else {
            socket.emit('stop_failed', { 
                message: 'لم يتم اعتماد التوقف! الإجابات غير كافية.',
                answers: evaluation 
            });
        }
    });

    socket.on('disconnect', () => { console.log(`لاعب فصل: ${socket.id}`); });
});
// حدث طرد لاعب من قبل المنشئ
socket.on('kick_player', (data) => {
    const { roomCode, targetId } = data;
    const room = activeRooms[roomCode];

    // التأكد من أن مرسل الطلب هو منشئ الغرفة فعلياً
    if (room && room.creatorId === socket.id) {
        // إخبار اللاعب المستهدف أنه تم طرده ليتم توجيهه لصفحة البداية
        io.to(targetId).emit('you_are_kicked');

        // البحث عن اسم اللاعب المطرود لإرسال رسالة تنبيه للبقية
        const kickedPlayer = room.players.find(p => p.id === targetId);
        const kickedName = kickedPlayer ? kickedPlayer.name : "لاعب";

        // حذف اللاعب من مصفوفة الغرفة
        room.players = room.players.filter(p => p.id !== targetId);

        // تحديث القائمة عند الجميع في الغرفة
        io.to(roomCode).emit('room_info', {
            players: room.players,
            creatorId: room.creatorId,
            settings: room.settings
        });

        // إرسال رسالة نظام للغرفة تخبرهم بالطرد
        io.to(roomCode).emit('system_message', { 
            message: `🚫 تم طرد اللاعب ${kickedName} من قبل المنشئ.`,
            color: '#e74c3c' 
        });

        console.log(`🚫 تم طرد لاعب من الغرفة ${roomCode}`);
    }
});
io.on('connection', (socket) => {
    console.log('لاعب جديد متصل:', socket.id);

    // ... هنا توجد الأكواد الأخرى مثل identify_player و start_game ...

    // ⬇️ أضف كود الـ Disconnect هنا ⬇️
    socket.on('disconnect', () => {
        for (const roomCode in activeRooms) {
            const room = activeRooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                const playerName = room.players[playerIndex].name;
                
                // 1. حذف اللاعب من قائمة الغرفة
                room.players.splice(playerIndex, 1);

                // 2. إذا كان اللاعب الذي خرج هو المنشئ، اجعل اللاعب التالي هو المنشئ
                if (socket.id === room.creatorId && room.players.length > 0) {
                    room.creatorId = room.players[0].id;
                }

                // 3. إذا أصبحت الغرفة فارغة تماماً، احذف الغرفة من الذاكرة لتوفير المساحة
                if (room.players.length === 0) {
                    delete activeRooms[roomCode];
                    console.log(`🗑️ تم حذف الغرفة الفارغة: ${roomCode}`);
                } else {
                    // 4. إرسال القائمة المحدثة لمن تبقى في الغرفة
                    io.to(roomCode).emit('room_info', {
                        players: room.players,
                        creatorId: room.creatorId,
                        settings: room.settings
                    });
                }

                console.log(`🔌 اللاعب ${playerName} غادر الغرفة ${roomCode}`);
                break; // نخرج من الحلقة لأن اللاعب غادر غرفة واحدة فقط
            }
        }
    });
}); // نهاية قوس الـ connection
server.listen(PORT, () => {
    console.log(`✅ الخادم يعمل على المنفذ: http://localhost:${PORT}`);
});