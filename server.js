require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

const upload = multer({ storage: multer.memoryStorage() });

const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || 'APP_USR-3922552857820372-100920-07bc79655acaddc2ab1a10b9fd7e4f7a-71867761' 
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let licencas = {}; 
let pagamentosPendentes = {}; 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Verificar Status da Licença
app.post('/api/licenca/verificar', (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'ID obrigatório.' });

    let licenca = licencas[deviceId];
    if (!licenca) {
        const dataExpiracao = new Date();
        dataExpiracao.setHours(dataExpiracao.getHours() + 1);
        licenca = { expiracao: dataExpiracao.toISOString(), plano: 'Teste Grátis', ativo: true };
        licencas[deviceId] = licenca;
    }

    const agora = new Date();
    const expiraEm = new Date(licenca.expiracao);
    const tempoRestanteMs = expiraEm - agora;

    if (tempoRestanteMs <= 0) {
        return res.json({ status: 'expirado', mensagem: 'Sua licença expirou.' });
    }

    return res.json({
        status: 'ativo',
        plano: licenca.plano,
        expiracao: licenca.expiracao,
        tempoRestanteMs: tempoRestanteMs
    });
});

// 2. Gerar Pagamento PIX Real no Mercado Pago
app.post('/api/pagamento/criar-pix', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'ID obrigatório.' });

    try {
        const payment = new Payment(client);
        const body = {
            transaction_amount: 20.00,
            description: 'RotaFácil - Assinatura Mensal (30 Dias)',
            payment_method_id: 'pix',
            payer: { email: 'cliente@rotafacil.com' }
        };

        const response = await payment.create({ body });
        const paymentId = response.id;
        const qrCodeBase64 = response.point_of_interaction.transaction_data.qr_code_base64;
        const qrCodeCopiaCola = response.point_of_interaction.transaction_data.qr_code;

        pagamentosPendentes[paymentId] = deviceId;
        res.json({ success: true, paymentId, qrCodeBase64, qrCodeCopiaCola });
    } catch (error) {
        console.error("Erro ao gerar Pix:", error);
        res.status(500).json({ error: 'Erro ao conectar com o gateway de pagamento.' });
    }
});

// 3. Consultar Status do Pagamento
app.post('/api/pagamento/verificar-status', async (req, res) => {
    const { paymentId, deviceId } = req.body;
    if (!paymentId || !deviceId) return res.status(400).json({ error: 'Dados incompletos.' });

    try {
        const payment = new Payment(client);
        const response = await payment.get({ id: paymentId });

        if (response.status === 'approved') {
            let dataExpiracao = new Date();
            if (licencas[deviceId] && new Date(licencas[deviceId].expiracao) > new Date()) {
                dataExpiracao = new Date(licencas[deviceId].expiracao);
            }
            dataExpiracao.setDate(dataExpiracao.getDate() + 30);

            licencas[deviceId] = {
                expiracao: dataExpiracao.toISOString(),
                plano: 'Plano 30 Dias',
                ativo: true
            };

            delete pagamentosPendentes[paymentId];
            return res.json({ aprovado: true, plano: 'Plano 30 Dias', expiracao: dataExpiracao.toISOString() });
        }

        return res.json({ aprovado: false, status: response.status });
    } catch (error) {
        console.error("Erro ao consultar status:", error);
        res.json({ aprovado: false });
    }
});

// 4. Rota para Extrair Endereços de PDF ou Fotos
app.post('/api/extrair-enderecos', upload.any(), async (req, res) => {
    try {
        const file = (req.files && req.files.length > 0) ? req.files[0] : req.file;
        
        if (!file) {
            return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });
        }

        const fileBuffer = file.buffer;
        const mimeType = file.mimetype || '';
        const fileName = file.originalname || '';
        let textoExtraido = "";

        if (mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
            try {
                const pdfData = await pdfParse(fileBuffer);
                textoExtraido = pdfData.text;
            } catch (pdfErr) {
                textoExtraido = fileBuffer.toString('utf8');
            }
        } else {
            const imagePart = {
                inlineData: {
                    data: fileBuffer.toString("base64"),
                    mimeType: mimeType || 'image/jpeg'
                },
            };
            const prompt = `Analise esta imagem e extraia todos os endereços, ruas e CEPs de entrega listados nela.`;
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [prompt, imagePart]
            });
            textoExtraido = response.text;
        }

        if (!textoExtraido || textoExtraido.trim().length === 0) {
            return res.json({ success: true, enderecos: [] });
        }

        const promptJson = `A partir do texto abaixo, extraia todos os endereços de entrega (ruas, avenidas, CEPs) formatados em sequência.
Retorne APENAS um array JSON puro contendo strings com os endereços limpos (ex: ["Rua A, 123", "Av B, 456, CEP 11000-000"]). 
Não inclua nenhum texto ou formatação markdown adicional fora do array JSON. Se não encontrar endereços, retorne [].

Texto:
${textoExtraido}`;

exports = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: promptJson
        });

        let textoResposta = exports.text.trim();
        textoResposta = textoResposta.replace(/```json/g, '').replace(/```/g, '').trim();
        const enderecos = JSON.parse(textoResposta);

        return res.json({ success: true, enderecos });

    } catch (error) {
        console.error("Erro detalhado na rota extrair-enderecos:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Rota segura de Geocodificação (Protegida contra respostas HTML e erros de sintaxe)
app.post('/api/geocodificar', async (req, res) => {
    const { endereco } = req.body;
    if (!endereco) return res.status(400).json({ error: 'Endereço obrigatório.' });

    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(endereco + ', Brasil')}&limit=1`;
        const response = await fetch(url, {
            headers: { 
                'User-Agent': 'RotaFacilApp/2.3 (contato@rotafacil.com)' 
            }
        });

        const textResponse = await response.text();
        
        // Garante que a resposta é JSON válido e não uma página HTML de erro do servidor de mapas
        if (!textResponse.startsWith('[') && !textResponse.startsWith('{')) {
            return res.json({ success: false, error: 'Resposta inválida do serviço de mapas' });
        }

        const data = JSON.parse(textResponse);

        if (data && data.length > 0) {
            return res.json({ success: true, lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) });
        }
        return res.json({ success: false });
    } catch (error) {
        console.error("Erro na geocodificação:", error.message);
        return res.json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor RotaFácil rodando em http://localhost:${PORT}`);
});