const express = require('express');
const cors = require('cors');
const path = require('path');
const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ⚠️ INSIRA SEU ACCESS TOKEN DO MERCADO PAGO AQUI
const client = new MercadoPagoConfig({ accessToken: 'APP_USR-1023386284133893-100920-935fcd599095003c51437217c39551b0-3579990383' });

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
        
        // Criação de pagamento PIX de R$ 29,90 (ou o valor da sua assinatura)
        const body = {
            transaction_amount: 29.90,
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

        // Associa o ID do pagamento ao deviceId para sabermos quem vai receber a licença
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

// 3. Consultar Status do Pagamento (O app vai ficar checando isso automaticamente)
app.post('/api/pagamento/verificar-status', async (req, res) => {
    const { paymentId, deviceId } = req.body;
    if (!paymentId || !deviceId) return res.status(400).json({ error: 'Dados incompletos.' });

    try {
        const payment = new Payment(client);
        const response = await payment.get({ id: paymentId });

        if (response.status === 'approved') {
            // PAGAMENTO APROVADO COM SUCESSO! LIBERA OS 30 DIAS AUTOMATICAMENTE
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

            // Remove da lista de pendentes
            delete pagamentosPendentes[paymentId];

            return res.json({ aprovado: true, plano: 'Plano 30 Dias', expiracao: dataExpiracao.toISOString() });
        }

        return res.json({ aprovado: false, status: response.status });

    } catch (error) {
        console.error("Erro ao consultar status:", error);
        res.json({ aprovado: false });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor RotaFácil (Modo Real) rodando em http://localhost:${PORT}`);
});