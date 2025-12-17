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

// مفاتيح المصادقة وقاعدة البيانات
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "150394320903-79ve7o5v80r87l4ko8807hq3erjlprc3.apps.googleusercontent.com"; 
const MONGODB_URI = process.env.MONGODB_URI; 
const client = new OAuth2Client(GOOGLE_CLIENT_ID);
const GEMINI_API_KEY = process.env.ENV_GEMINI_API_KEY; 

const UserSchema = new mongoose.Schema({
    googleId: { type: String, unique: true, sparse: true },
    email: { type: String, unique: true, sparse: true },
    password: { type: String },
    username: { type: String, required: true },
    wins: { type: Number, default: 0 },
    totalScore: { type: Number, default: 0 },
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

mongoose.connect(MONGODB_URI)
    .then(() => console.log("✅ متصل بقاعدة بيانات MongoDB"))
    .catch(err => console.error("❌ فشل الاتصال بقاعدة بيانات MongoDB:", err));

async function verifyGoogleToken(token) {
    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });
        return ticket.getPayload();
    } catch (error) {
        return null;
    }
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

async function checkAnswersWithAI(letter, answers) {
    const prompt = `أنت محكّم خبير للعبة حيوان جماد نبات. الحرف: ${letter}. قيم الإجابات: ${JSON.stringify(answers)}. أجب بـ (حيوان: صحيح/خطأ) لكل فئة.`;
    try {
        const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`, {
            contents: [{ parts: [{ text: prompt }] }],
        }, { timeout: 8000 });
        const aiText = response.data.candidates[0].content.parts[0].text;
        const results = {};
        let isValid = aiText.includes('صحيح');
        return { evaluation: results, success: isValid };
    } catch (error) {
        return { evaluation: {}, success: false, error: true }; 
    }
}

app.use(express.static(path.join(__dirname)));

// ******************************************************
// ** بداية نطاق الاتصال - Socket Events **
// ******************************************************
io.on('connection', (socket) => {
    console.log(`👤 لاعب متصل: ${socket.id}`);

    // المصادقة عبر جوجل
    socket.on('google_login', async (data) => {
        const payload = await verifyGoogleToken(data.token);
        if (!payload) return socket.emit('auth_error', { message: 'رمز غير صالح' });
        try {
            let user = await User.findOne({ googleId: payload.sub });
            if (!user) {
                user = new User({ googleId: payload.sub, username: payload.name });
                await user.save();
            }
            socket.emit('auth_success', { username: user.username, wins: user.wins });
        } catch (error) { socket.emit('auth_error', { message: 'خطأ قاعدة بيانات' }); }
    });

    // إنشاء حساب يدوي
    socket.on('register_request', async (data) => {
        try {
            const { email, password, username } = data;
            const existingUser = await User.findOne({ email });
            if (existingUser) return socket.emit('auth_error', { message: 'البريد مستخدم!' });
            const hashedPassword = await bcrypt.hash(password, 10);
            const newUser = new User({ email, password: hashedPassword, username });
            await newUser.save();
            socket.emit('auth_success', { username: newUser.username, wins: 0 });
        } catch (error) { socket.emit('auth_error', { message: 'فشل الإنشاء' }); }
    });

    // تسجيل دخول يدوي
    socket.on('login_request', async (data) => {
        try {
            const user = await User.findOne({ email: data.email });
            if (!user || !user.password) return socket.emit('auth_error', { message: 'بيانات خاطئة' });
            const isMatch = await bcrypt.compare(data.password, user.password);
            if (!isMatch) return socket.emit('auth_error', { message: 'كلمة سر خطأ' });
            socket.emit('auth_success', { username: user.username, wins: user.wins });
        } catch (error) { socket.emit('auth_error', { message: 'فشل الدخول' }); }
    });

    // إنشاء غرفة
    socket.on('create_room_request', (data) => {
        let roomCode = generateRoomCode();
        const initialLetter = selectRandomLetter([]);
        socket.join(roomCode);
        activeRooms[roomCode] = { 
            players: [{ id: socket.id, name: data.playerName, wins: 0, score: 0 }],
            currentLetter: initialLetter, 
            usedLetters: [initialLetter],
            creatorId: socket.id,
            settings: { rounds: 5, time: 90, currentRound: 0 }
        };
        socket.emit('room_created', { roomCode });
    });

    // الانضمام لغرفة
    socket.on('join_room_request', (data) => {
        const room = activeRooms[data.roomCode];
        if (room) {
            socket.join(data.roomCode);
            room.players.push({ id: socket.id, name: data.playerName, wins: 0, score: 0 });
            socket.emit('room_joined', { roomCode: data.roomCode });
            io.to(data.roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
        }
    });

    // تعريف هوية اللاعب في الانتظار
    socket.on('identify_player', async (data) => {
        const room = activeRooms[data.roomCode];
        if (room) {
            const userDb = await User.findOne({ username: data.playerName });
            let player = room.players.find(p => p.id === socket.id);
            if (!player) {
                player = { id: socket.id, name: data.playerName, wins: userDb ? userDb.wins : 0, score: 0 };
                room.players.push(player);
            }
            io.to(data.roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
        }
    });

    // طرد لاعب
    socket.on('kick_player', (data) => {
        const room = activeRooms[data.roomCode];
        if (room && room.creatorId === socket.id) {
            io.to(data.targetId).emit('you_are_kicked');
            room.players = room.players.filter(p => p.id !== data.targetId);
            io.to(data.roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
        }
    });

    // فوز لاعب وتحديث السجل
    socket.on('update_winner_score', async (data) => {
        try {
            await User.findOneAndUpdate({ username: data.playerName }, { $inc: { wins: 1 } });
            console.log(`🏆 فوز جديد للاعب: ${data.playerName}`);
        } catch (e) { console.log("خطأ تحديث فوز"); }
    });

    // الخروج والـ Disconnect
    socket.on('disconnect', () => {
        for (const roomCode in activeRooms) {
            const room = activeRooms[roomCode];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                room.players.splice(pIdx, 1);
                if (room.players.length === 0) delete activeRooms[roomCode];
                else {
                    if (socket.id === room.creatorId) room.creatorId = room.players[0].id;
                    io.to(roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
                }
                break;
            }
        }
    });

    // استكمال باقي الأحداث (Settings, Start Game, Stop Game) داخل هذا النطاق...
    socket.on('update_settings', (data) => {
        const room = activeRooms[data.roomCode];
        if (room && room.creatorId === socket.id) {
            room.settings.rounds = data.rounds;
            room.settings.time = data.time;
            io.to(data.roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
        }
    });

    socket.on('start_game', (data) => {
        const room = activeRooms[data.roomCode];
        if (room && room.creatorId === socket.id) {
            io.to(data.roomCode).emit('game_started', { roomCode: data.roomCode, settings: room.settings });
        }
    });

}); // نهاية قوس الاتصال io.on

server.listen(PORT, () => {
    console.log(`✅ الخادم يعمل على: http://localhost:${PORT}`);
});