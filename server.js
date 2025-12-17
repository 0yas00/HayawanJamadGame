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

    // --- إنشاء غرفة (تم التعديل لضمان الحفظ) ---
    socket.on('create_room_request', async (data) => {
        let roomCode = generateRoomCode();
        const initialLetter = selectRandomLetter([]);
        
        const userDb = await User.findOne({ username: data.playerName });
        const wins = userDb ? userDb.wins : 0;

        socket.join(roomCode);
        activeRooms[roomCode] = { 
            players: [{ id: socket.id, name: data.playerName, wins: wins, score: 0 }],
            currentLetter: initialLetter, 
            usedLetters: [initialLetter],
            creatorId: socket.id,
            settings: { rounds: 5, time: 90, currentRound: 0 }
        };
        console.log(`✅ تم إنشاء غرفة وحفظها: ${roomCode}`);
        socket.emit('room_created', { roomCode });
    });

    // --- الانضمام لغرفة (تم التعديل لضمان المطابقة) ---
    socket.on('join_room_request', async (data) => {
        const roomCode = String(data.roomCode).trim();
        const room = activeRooms[roomCode];

        console.log(`🔎 محاولة دخول: "${roomCode}" | الغرف المتاحة: ${Object.keys(activeRooms)}`);

        if (room) {
            socket.join(roomCode);
            const userDb = await User.findOne({ username: data.playerName });
            const wins = userDb ? userDb.wins : 0;

            if (!room.players.find(p => p.id === socket.id)) {
                room.players.push({ id: socket.id, name: data.playerName, wins: wins, score: 0 });
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
    });

    // --- تعريف الهوية في الانتظار (تم توحيدها وتعديلها) ---
    socket.on('identify_player', async (data) => {
        const roomCode = String(data.roomCode).trim();
        const room = activeRooms[roomCode];
        
        if (room) {
            const userDb = await User.findOne({ username: data.playerName });
            const wins = userDb ? userDb.wins : 0;

            let player = room.players.find(p => p.id === socket.id);
            if (!player) {
                player = { id: socket.id, name: data.playerName, wins: wins, score: 0 };
                room.players.push(player);
                
                io.to(roomCode).emit('system_message', { 
                    message: `📢 انضم ${data.playerName} إلى الغرفة`,
                    color: '#27ae60' 
                });
            }

            io.to(roomCode).emit('room_info', { 
                players: room.players, 
                creatorId: room.creatorId, 
                settings: room.settings 
            });
        } else {
            socket.emit('room_error', { message: "عذراً، الغرفة غير موجودة أو انتهت صلاحيتها." });
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

    // --- الخروج (Disconnect) ---
    socket.on('disconnect', () => {
        for (const roomCode in activeRooms) {
            const room = activeRooms[roomCode];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                const pName = room.players[pIdx].name;
                room.players.splice(pIdx, 1);
                
                if (room.players.length === 0) {
                    delete activeRooms[roomCode];
                } else {
                    if (socket.id === room.creatorId) room.creatorId = room.players[0].id;
                    io.to(roomCode).emit('room_info', { players: room.players, creatorId: room.creatorId, settings: room.settings });
                    io.to(roomCode).emit('system_message', { message: `🚪 غادر ${pName} الغرفة`, color: '#e74c3c' });
                }
                break;
            }
        }
    });

    // --- إعدادات المباراة وبدء اللعب ---
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
});

server.listen(PORT, () => {
    console.log(`✅ الخادم يعمل بنجاح على المنفذ: ${PORT}`);
});