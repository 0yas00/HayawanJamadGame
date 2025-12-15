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
const GEMINI_API_KEY = "AIzaSyAi4LC7bmWF3RJq8BaH025NelxAnFzWta8"; 

// هيكل لحفظ الغرف النشطة وبياناتها
const activeRooms = {}; 

// قائمة الحروف المتاحة (يمكنك تعديلها)
const AVAILABLE_LETTERS = ['أ', 'ب', 'ت', 'ج', 'ح', 'خ', 'د', 'ر', 'ز', 'س', 'ش', 'ص', 'ط', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'];

// -----------------------------------------------------
// الدوال المساعدة
// -----------------------------------------------------

/** توليد رمز غرفة عشوائي مكون من 6 أرقام */
function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/** اختيار حرف عشوائي غير مستخدم في الغرفة */
function selectRandomLetter(usedLetters) {
    const remainingLetters = AVAILABLE_LETTERS.filter(letter => !usedLetters.includes(letter));
    if (remainingLetters.length === 0) {
        return null;
    }
    const randomIndex = Math.floor(Math.random() * remainingLetters.length);
    return remainingLetters[randomIndex];
}

/** دالة التحقق باستخدام الذكاء الاصطناعي */
async function checkAnswersWithAI(letter, answers) {
    const prompt = `أنت محكّم خبير للعبة حيوان جماد نبات (اسم/حيوان/نبات/جماد/بلاد) باللغة العربية. 
    الحرف المطلوب هو: ${letter}. 
    الرجاء تقييم الإجابات التالية. لكل إجابة، أعد كلمة "صحيح" أو "خطأ" فقط.
    
    1. حيوان: ${answers.حيوان}
    2. جماد: ${answers.جماد}
    3. نبات: ${answers.نبات}
    4. بلاد: ${answers.بلاد}
    5. اسم: ${answers.اسم}
    
    النتيجة:`;

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
                if (results.جمad === 'صحيح') isValid = true;
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
    socket.on('create_room_request', () => {
        let roomCode = generateRoomCode();
        while (activeRooms[roomCode]) {
            roomCode = generateRoomCode();
        }

        const initialLetter = selectRandomLetter([]); 

        socket.join(roomCode);
        
        activeRooms[roomCode] = { 
            players: [{ id: socket.id, name: "غير محدد" }],
            currentLetter: initialLetter, 
            usedLetters: [initialLetter]
        };
        
        console.log(`تم إنشاء الغرفة: ${roomCode} بالحرف ${initialLetter}`);
        
        // إرسال الرمز فقط إلى اللاعب (إخفاء الحرف)
        socket.emit('room_created', { 
            roomCode: roomCode, 
        });
    });

    // 2. طلب الانضمام لغرفة خاصة (من صفحة اللوبي)
    socket.on('join_room_request', (data) => {
        const { roomCode, playerName } = data;

        if (activeRooms[roomCode]) {
            socket.join(roomCode);
            activeRooms[roomCode].players.push({ id: socket.id, name: playerName });
            
            console.log(`اللاعب ${playerName} انضم إلى الغرفة: ${roomCode}`);

            // إرسال بيانات الغرفة للاعب المنضم (إخفاء الحرف)
            socket.emit('room_joined', { 
                roomCode: roomCode,
            });
            
            socket.to(roomCode).emit('player_joined', { name: playerName, message: `${playerName} انضم إلى التحدي!` });
        } else {
            socket.emit('room_error', { message: 'رمز الغرفة غير صحيح أو الغرفة غير موجودة.' });
        }
    });

    // 3. طلب الحصول على الحرف (يتم استدعاؤه فقط عند دخول game.html)
    socket.on('get_room_letter', (roomCode) => {
        if (activeRooms[roomCode] && activeRooms[roomCode].currentLetter) {
            // إرسال الحرف مرة واحدة للاعب الذي طلبه
            socket.emit('room_letter', { 
                currentLetter: activeRooms[roomCode].currentLetter
            });
        }
    });
    
    // 4. معالجة طلب إيقاف الوقت والتحقق بالذكاء الاصطناعي
    socket.on('stop_game_request', async (data) => {
        const { roomCode, playerName, answers, currentLetter } = data;
        
        const { evaluation, success, error } = await checkAnswersWithAI(currentLetter, answers);

        if (error) {
            socket.emit('stop_failed', { message: 'فشل التحقق بسبب خطأ تقني. يرجى المتابعة.' });
            return;
        }

        if (success) {
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
        console.log(`لاعب فصل الاتصال: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`✅ الخادم يعمل على المنفذ: http://localhost:${PORT}`);
});