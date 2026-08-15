require('dotenv').config();
const express = require('express');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 30 * 1000;
const DONATIE_AFZENDER = 'no-reply@community-fundraising.com';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/gezondheid', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function stuurNaarOverlays(data) {
    const bericht = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(bericht);
    }
}

// Meldt de donatie ook in #beheerders (alleen zichtbaar voor Hart-Beheer), via een webhook zodat
// dit servertje geen bot-token nodig heeft.
async function stuurNaarDiscord(donatie) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return;

    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                type: 'rich',
                color: 0x1F7A4C,
                title: '💚 Streamers met een Hart heeft een donatie ontvangen!',
                description: `**${donatie.naam}** doneerde **€${donatie.bedrag}**`,
                timestamp: new Date().toISOString(),
            }],
        }),
    }).catch(err => console.error('Discord-webhook mislukt:', err.message));
}

wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'verbonden' }));
});

// ---------- Donatiemail herkennen ----------
// Gebaseerd op een echte mail van Stichting Opkikker <no-reply@community-fundraising.com>:
// onderwerp "Je team heeft een donatie ontvangen", inhoud met de regels
// "Naam donateur: ..." en "Bedrag: € ...".
function verwerkMail(parsed) {
    if (!/donatie ontvangen/i.test(parsed.subject || '')) return null;

    const tekst = parsed.text || '';
    const bedragMatch = tekst.match(/Bedrag:\s*€\s?([\d.,]+)/i);
    if (!bedragMatch) return null;

    const naamMatch = tekst.match(/Naam donateur:\s*([^\n]+)/i);

    return {
        bedrag: bedragMatch[1].replace('.', '').replace(',', '.'),
        naam: naamMatch ? naamMatch[1].trim() : 'Iemand anoniem',
    };
}

async function checkMailbox() {
    const { IMAP_HOST, IMAP_USER, IMAP_PASSWORD } = process.env;
    if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
        console.log('IMAP niet geconfigureerd, sla mailcheck over.');
        return;
    }

    const client = new ImapFlow({
        host: IMAP_HOST,
        port: 993,
        secure: true,
        auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
        logger: false,
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            // Zoekt bewust alleen op afzender, zodat de rest van de persoonlijke mailbox van de
            // eigenaar volledig onaangeroerd blijft (niet gelezen, niet geopend, niks).
            const onbekend = await client.search({ seen: false, from: DONATIE_AFZENDER });
            for (const uid of onbekend) {
                const { content } = await client.download(uid);
                const parsed = await simpleParser(content);

                const donatie = verwerkMail(parsed);
                if (donatie) {
                    console.log(`Nieuwe donatie herkend: €${donatie.bedrag} van ${donatie.naam}`);
                    stuurNaarOverlays({ type: 'donatie', ...donatie });
                    await stuurNaarDiscord(donatie);
                }

                await client.messageFlagsAdd(uid, ['\\Seen']);
            }
        } finally {
            lock.release();
        }
    } catch (err) {
        console.error('Mailbox uitlezen mislukt:', err.message);
    } finally {
        await client.logout().catch(() => {});
    }
}

server.listen(PORT, () => {
    console.log(`✅ Overlay-server actief op poort ${PORT}`);
    checkMailbox();
    setInterval(checkMailbox, POLL_INTERVAL_MS);
});
