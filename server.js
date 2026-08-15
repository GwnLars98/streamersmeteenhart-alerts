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
                title: '🐸 Streamers met een Hart heeft een donatie ontvangen!',
                description: `**${donatie.naam}** doneerde **€${donatie.bedrag}** aan **Stichting Opkikker** 💚`,
                timestamp: new Date().toISOString(),
            }],
        }),
    }).catch(err => console.error('Discord-webhook mislukt:', err.message));
}

wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'verbonden' }));
});

// Simuleert een donatie (overlay + Discord), zonder dat er echt gedoneerd hoeft te worden.
// Vereist TEST_SECRET als querystring-param, zodat niet zomaar iedereen op het internet dit kan
// triggeren.
app.get('/test-donatie', async (req, res) => {
    const secret = process.env.TEST_SECRET;
    if (!secret || req.query.secret !== secret) return res.status(403).send('geen toegang');

    const donatie = { naam: req.query.naam || 'Test Donateur', bedrag: req.query.bedrag || '5' };
    stuurNaarOverlays({ type: 'donatie', ...donatie });
    await stuurNaarDiscord(donatie);
    res.send(`test-donatie verstuurd: €${donatie.bedrag} van ${donatie.naam}`);
});

// Zuivere inspectie: haalt de LAATSTE mail van de donatie-afzender op (ongeacht gelezen-status,
// markeert niks) en toont het rauwe onderwerp + platte tekst, zodat we kunnen zien hoe een
// echte mail er precies uitziet als de regex 'm niet herkent.
app.get('/debug-mail', async (req, res) => {
    const secret = process.env.TEST_SECRET;
    if (!secret || req.query.secret !== secret) return res.status(403).send('geen toegang');

    const { IMAP_HOST, IMAP_USER, IMAP_PASSWORD } = process.env;
    if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) return res.type('text/plain').send('IMAP niet geconfigureerd.');

    const client = new ImapFlow({
        host: IMAP_HOST, port: 993, secure: true,
        auth: { user: IMAP_USER, pass: IMAP_PASSWORD }, logger: false,
    });

    let output = '';
    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const alles = await client.search({ from: DONATIE_AFZENDER });
            output += `${alles.length} bericht(en) totaal van ${DONATIE_AFZENDER}.\n\n`;
            const laatste = alles[alles.length - 1];
            if (laatste) {
                const { content } = await client.download(laatste);
                const parsed = await simpleParser(content);
                output += `ONDERWERP: ${JSON.stringify(parsed.subject)}\n\n`;
                output += `PLATTE TEKST (parsed.text):\n${JSON.stringify(parsed.text)}\n\n`;
                output += `HTML AANWEZIG: ${Boolean(parsed.html)}\n`;
            } else {
                output += '(geen berichten gevonden)';
            }
        } finally {
            lock.release();
        }
    } catch (err) {
        output += 'Fout: ' + err.message;
    } finally {
        await client.logout().catch(() => {});
    }

    res.type('text/plain').send(output);
});

// ---------- Donatiemail herkennen ----------
// Opkikker stuurt per donatie TWEE mails vanaf hetzelfde adres: één naar de teamkapitein
// ("Je team heeft een donatie ontvangen", met "Naam donateur:"/"Bedrag: €"-regels) en één naar de
// donateur zelf ("Bedankt voor jouw bijdrage!", met "Donatiebedrag:"). We willen alleen de eerste,
// dus wordt bewust exact op dat onderwerp gefilterd, niet alleen op "donatie" ergens in de tekst.
function verwerkMail(parsed) {
    if (!/team heeft een donatie ontvangen/i.test(parsed.subject || '')) return null;

    const tekst = parsed.text || '';
    const bedragMatch = tekst.match(/(?<!Donatie)Bedrag:\s*€\s?([\d.,]+)/i);
    if (!bedragMatch) return null;

    const naamMatch = tekst.match(/Naam donateur:\s*([^\n]+)/i);

    return {
        bedrag: bedragMatch[1].replace('.', '').replace(',', '.'),
        naam: naamMatch ? naamMatch[1].trim() : 'Iemand anoniem',
    };
}

// Retourneert altijd een array met logregels (naast dat elke regel ook naar console.log gaat),
// zodat /debug-check dit rechtstreeks kan teruggeven zonder dat iemand in de Railway-logs hoeft
// te kijken.
async function checkMailbox() {
    const regels = [];
    const log = msg => { console.log(msg); regels.push(msg); };

    const { IMAP_HOST, IMAP_USER, IMAP_PASSWORD } = process.env;
    if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
        log('IMAP niet geconfigureerd, sla mailcheck over.');
        return regels;
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
        log('IMAP-verbinding gelukt.');
        const lock = await client.getMailboxLock('INBOX');
        try {
            // Zoekt bewust alleen op afzender, zodat de rest van de persoonlijke mailbox van de
            // eigenaar volledig onaangeroerd blijft (niet gelezen, niet geopend, niks).
            const onbekend = await client.search({ seen: false, from: DONATIE_AFZENDER });
            log(`${onbekend.length} ongelezen bericht(en) gevonden van ${DONATIE_AFZENDER}.`);

            for (const uid of onbekend) {
                const { content } = await client.download(uid);
                const parsed = await simpleParser(content);
                log(`Bericht gevonden: onderwerp = "${parsed.subject}"`);

                const donatie = verwerkMail(parsed);
                if (donatie) {
                    log(`Nieuwe donatie herkend: €${donatie.bedrag} van ${donatie.naam}`);
                    stuurNaarOverlays({ type: 'donatie', ...donatie });
                    await stuurNaarDiscord(donatie);
                } else {
                    log('-> matchte niet het donatie-patroon, overgeslagen.');
                }

                await client.messageFlagsAdd(uid, ['\\Seen']);
            }
        } finally {
            lock.release();
        }
    } catch (err) {
        log('Mailbox uitlezen mislukt: ' + err.message);
    } finally {
        await client.logout().catch(() => {});
    }

    return regels;
}

// Forceert direct een mailcheck en toont precies wat er gebeurde, i.p.v. te wachten op de
// volgende automatische ronde (elke 30s) en in Railway's dashboard te moeten kijken.
app.get('/debug-check', async (req, res) => {
    const secret = process.env.TEST_SECRET;
    if (!secret || req.query.secret !== secret) return res.status(403).send('geen toegang');

    const regels = await checkMailbox();
    res.type('text/plain').send(regels.join('\n') || '(geen output)');
});

server.listen(PORT, () => {
    console.log(`✅ Overlay-server actief op poort ${PORT}`);
    checkMailbox();
    setInterval(checkMailbox, POLL_INTERVAL_MS);
});
