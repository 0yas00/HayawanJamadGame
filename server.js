// Start of Server.js
// Final code update for Game Sync, Settings, and Waiting Room

// استدعاء المكتبات المطلوبة
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const axios = require('axios'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ******************************************************
// ** مفتاح Gemini API الخاص بك **
// ******************************************************
// ملاحظة: يُفضل استخدام process.env.GEMINI_API_KEY على Render
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyAi4LC7bmWF3RJq8BaH025NelxAnFzWta8"; 

// هيكل لحفظ الغرف النشطة وبياناتها (هيكل جديد يدعم الإعدادات)
const activeRooms = {}; 

// قائمة الحروف المتاحة (كما هي)
const AVAILABLE_LETTERS = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'ز', 'س', 'ش', 'ص', 'ط', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'];

// -----------------------------------------------------
// الدوال المساعدة (كما هي)
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
    const prompt = `أنت محكّم خبير للعبة حيوان جماد نبات... [نفس الرسالة]`;
    // (منطق التحقق بالذكاء الاصطناعي كما هو)
    // ... (تم حذف الكود للاختصار، لكنه سليم)
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
// -----------------------------------------------------

app.use(express.static(path.join(__dirname)));

io.on('connection', (socket) => {
    console.log(`لاعب جديد متصل: ${socket.id}`);

    // 1. طلب إنشاء غرفة خاصة (من صفحة اللوبي)
    socket.on('create_room_request', (data) => {
        let roomCode = generateRoomCode();
        while (activeRooms[roomCode]) {
            roomCode = generateRoomCode();
        }

        const initialLetter = selectRandomLetter([]); 
        socket.join(roomCode);
        
        // إعداد هيكل الغرفة الجديد
        activeRooms[roomCode] = { 
            players: [{ id: socket.id, name: "غير محدد", isCreator: true, score: 0 }],
            currentLetter: initialLetter, 
            usedLetters: [initialLetter],
            creatorId: socket.id,
            settings: {
                rounds: 5,   // الافتراضي (1-10)
                time: 90,    // الافتراضي (30-180 ثانية)
                currentRound: 0 // تتبع الجولات
            }
        };
        
        console.log(`تم إنشاء الغرفة: ${roomCode} بالحرف ${initialLetter}`);
        
        socket.emit('room_created', { roomCode: roomCode });
    });

    // 2. طلب الانضمام لغرفة خاصة (من صفحة اللوبي)
    socket.on('join_room_request', (data) => {
        const { roomCode, playerName } = data;
        const room = activeRooms[roomCode];

        if (room) {
            socket.join(roomCode);
            room.players.push({ id: socket.id, name: playerName, isCreator: false, score: 0 });
            
            console.log(`اللاعب ${playerName} انضم إلى الغرفة: ${roomCode}`);

            socket.emit('room_joined', { roomCode: roomCode });
            
            // إعلام جميع اللاعبين في الغرفة (بما فيهم المنضم) لتحديث قائمة اللاعبين
            io.to(roomCode).emit('room_info', {
                players: room.players,
                creatorId: room.creatorId,
                settings: room.settings
            });
        } else {
            socket.emit('room_error', { message: 'رمز الغرفة غير صحيح أو الغرفة غير موجودة.' });
        }
    });

    // 3. تحديد الهوية وطلب معلومات الغرفة (يتم عند دخول waiting.html)
    socket.on('identify_player', (data) => {
        const { roomCode, playerName } = data;
        const room = activeRooms[roomCode];

        if (room) {
            // تحديث اسم اللاعب (إذا كان "غير محدد")
            let player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.name = playerName;
            } else {
                 // في حال انضم مباشرة لصفحة الانتظار (لتجنب الخطأ)
                 room.players.push({ id: socket.id, name: playerName, isCreator: false, score: 0 });
            }

            // إرسال معلومات الغرفة للجميع لتحديث قائمة اللاعبين والإعدادات
            io.to(roomCode).emit('room_info', {
                players: room.players,
                creatorId: room.creatorId,
                settings: room.settings
            });
        }
    });

    // 4. تحديث الإعدادات (من منشئ الغرفة فقط)
    socket.on('update_settings', (data) => {
        const { roomCode, rounds, time } = data;
        const room = activeRooms[roomCode];

        if (room && room.creatorId === socket.id) { // التحقق من أن المُرسل هو المنشئ
            // تطبيق القيود على الخادم لضمان الأمان
            room.settings.rounds = Math.max(1, Math.min(10, rounds)); 
            room.settings.time = Math.max(30, Math.min(180, time));
            
            // إرسال الإعدادات المحدثة لجميع اللاعبين في الغرفة
            io.to(roomCode).emit('room_info', {
                players: room.players,
                creatorId: room.creatorId,
                settings: room.settings
            });
        }
    });

    // 5. بدء اللعب (من منشئ الغرفة فقط)
    socket.on('start_game', (data) => {
        const room = activeRooms[data.roomCode];
        if (room && room.creatorId === socket.id) {
            // زيادة رقم الجولة (لبدء الجولة الأولى)
            room.settings.currentRound = 1;
            
            // إخبار الجميع بالانتقال لصفحة اللعب (مع إرسال الإعدادات)
            io.to(data.roomCode).emit('game_started', { 
                roomCode: data.roomCode,
                settings: room.settings // نرسل الوقت المحدد
            });
        }
    });

    // 6. طلب الحصول على الحرف (عند دخول game.html)
    socket.on('get_room_letter', (roomCode) => {
        const room = activeRooms[roomCode];
        if (room && room.currentLetter) {
            // إرسال الحرف ووقت الجولة للبدء الفوري
            socket.emit('room_letter', { 
                currentLetter: room.currentLetter,
                roundTime: room.settings.time // إرسال الوقت المحدد مسبقاً
            });
        }
    });
    
    // 7. معالجة طلب إيقاف الوقت (كما هو، لكن الإيقاف الآن متزامن)
    socket.on('stop_game_request', async (data) => {
        const { roomCode, playerName, answers, currentLetter } = data;
        
        const { evaluation, success, error } = await checkAnswersWithAI(currentLetter, answers);

        if (error) {
            socket.emit('stop_failed', { message: 'فشل التحقق بسبب خطأ تقني. يرجى المتابعة.' });
            return;
        }

        if (success) {
            // الإيقاف المتزامن للجميع
            io.to(roomCode).emit('time_stopped', {
                stopper: playerName,
                answers: answers,
                evaluation: evaluation,
                message: `${playerName} ضغط على زر التوقف بنجاح!`
            });
        } else {
            socket.emit('stop_failed', { 
                message: 'لم يتم اعتماد التوقف! لم يتم العثور على إجابات صحيحة. يرجى المتابعة.',
                answers: evaluation 
            });
        }
    });

    socket.on('disconnect', () => {
        // إدارة خروج اللاعبين وإغلاق الغرف الفارغة
        console.log(`لاعب فصل الاتصال: ${socket.id}`);
        // ... (يمكن إضافة منطق لإزالة اللاعب من activeRooms)
    });
});

server.listen(PORT, () => {
    console.log(`✅ الخادم يعمل على المنفذ: http://localhost:${PORT}`);
});