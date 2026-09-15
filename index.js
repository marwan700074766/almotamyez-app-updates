require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('❌ المتغير GEMINI_API_KEY غير مضبوط. أضفه إلى ملف .env قبل التشغيل.');
  process.exitCode = 1;
} else {
  const ai = new GoogleGenAI({ apiKey: API_KEY });

  testGemini(ai);
}

async function testGemini(ai) {
  try {
    console.log("⏳ جاري اختبار الاتصال بالنموذج المتاح لديك...");
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-computer-use-preview-10-2025',
      contents: 'مرحباً، هل تعمل بنجاح؟',
    });

    console.log('🎉 تم الاتصال بنجاح تام!');
    console.log('رد الذكاء الاصطناعي:', response.text);
  } catch (error) {
    console.error('❌ حدث خطأ:', error.message || error);
  }
}