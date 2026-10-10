require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Configuração do Upload em memória (para processar fotos e PDFs)
const upload = multer({ storage: multer.memoryStorage() });

// Configuração do Mercado Pago
const client = new MercadoPagoConfig({ 
    accessToken: process.env.MP_ACCESS_TOKEN || 'APP_USR-3922552857820372-100920-07bc79655acaddc2ab1a10b9fd7e4f7a-71867761' 
});

// Inicialização do Google Gen AI (Gemini) para leitura de documentos/fotos
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

let licencas = {}; // deviceId -> { expiracao, plano, paymentId }
let pagamentosPendentes = {}; // paymentId -> deviceId

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
        dataExpiracao.setHours(dataExpiracao.getHours() + 1); // Teste inicial de 1 hora
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
            payer: {
                email: 'cliente@rotafacil.com'
            }
        };

        const response = await payment.create({ body });
        
        const paymentId = response.id;
        const qrCodeBase64 = response.point_of_interaction.transaction_data.qr_code_base64;
        const qrCodeCopiaCola = response.point_of_interaction.transaction_data.qr_code;

        pagamentosPendentes[paymentId] = deviceId;

        res.json({
            success: true,
            paymentId,
            qrCodeBase64,
            qrCodeCopiaCola
        });

    } catch (error) {
        console.error("Erro ao gerar Pix no Mercado Pago:", error);
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

// 4. Nova Rota: Extrair Endereços de Foto ou PDF usando Gemini AI[cite: 1]
app.post('/api/extrair-enderecos', upload.single('arquivo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });
        }

        const fileBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;

        // Converte o arquivo para o formato esperado pelo SDK do Gemini
        const imagePart = {
            inlineData: {
                data: fileBuffer.toString("base64"),
                mimeType: mimeType
            },
        };

        const prompt = `Analise este arquivo (imagem ou PDF) e extraia todos os endereços de entrega listados nele. 
Retorne APENAS um array JSON puro contendo strings com os endereços limpos (ex: ["Rua A, 123 - Bairro - Cidade", "Av B, 456"]). 
Não inclua nenhum texto adicional fora do array JSON. Se não encontrar endereços, retorne [].`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [prompt, imagePart]
        });

        const textoResposta = response.text.trim();
        // Limpa possíveis marcações de bloco de código markdown caso o modelo retorne
        const jsonString = textoResposta.replace(/```json/g, '').replace(/```/g, '').trim();
        
        const enderecos = JSON.parse(jsonString);

        res.json({ success: true, enderecos });

    } catch (error) {
        console.error("Erro ao extrair endereços com IA:", error);
        res.status(500).json({ success: false, error: 'Erro ao processar o arquivo com Inteligência Artificial.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor RotaFácil rodando em http://localhost:${PORT}`);
});