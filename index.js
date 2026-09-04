// The Fine Print — Alerts Backend
// Runs on a schedule via GitHub Actions.
// 1. Checks UK, US, and Germany sources for new laws/regulations
// 2. Compares against the last-seen IDs (stored in Firestore)
// 3. For every subscribed device whose topic keywords match a new item,
//    sends a Web Push notification

const admin = require('firebase-admin');
const webpush = require('web-push');
const fetch = require('node-fetch');
const { DOMParser } = require('@xmldom/xmldom');

// ---------- Firebase setup ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ---------- Web Push setup ----------
webpush.setVapidDetails(
  'mailto:thefineprinthelp@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ---------- Source fetchers ----------
async function fetchUK() {
  const res = await fetch('https://www.legislation.gov.uk/all/data.feed?results-count=20');
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const entries = Array.from(doc.getElementsByTagName('entry'));
  return entries.map((entry) => {
    const title = entry.getElementsByTagName('title')[0]?.textContent || 'Untitled';
    const linkEls = Array.from(entry.getElementsByTagName('link'));
    let link = '';
    for (const l of linkEls) {
      if (l.getAttribute('rel') === 'alternate' || !l.getAttribute('rel')) { link = l.getAttribute('href'); break; }
    }
    if (!link && linkEls.length) link = linkEls[0].getAttribute('href');
    return { id: link || title, title, url: link, country: 'UK' };
  });
}

async function fetchUS() {
  const res = await fetch(
    'https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest'
  );
  const data = await res.json();
  return (data.results || []).map((doc) => ({
    id: doc.document_number,
    title: doc.title,
    url: doc.html_url,
    country: 'US',
  }));
}

async function fetchGermany() {
  const res = await fetch('https://testphase.rechtsinformationen.bund.de/v1/legislation');
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.member || data.data || data.items || data.results || []);
  return list.map((entry) => {
    const item = entry.item || entry;
    const title = item.name || item.alternateName || item.headline || item.title || 'Untitled';
    let url = '';
    if (Array.isArray(item.encoding)) {
      const htmlEnc = item.encoding.find((e) => e.encodingFormat === 'text/html');
      if (htmlEnc && htmlEnc.contentUrl) url = 'https://testphase.rechtsinformationen.bund.de' + htmlEnc.contentUrl;
    }
    if (!url && item['@id']) url = 'https://testphase.rechtsinformationen.bund.de' + item['@id'];
    return { id: url || title, title, url, country: 'Germany' };
  });
}

// ---------- Main ----------
async function main() {
  console.log('Checking for new laws...');

  const [uk, us, germany] = await Promise.all([
    fetchUK().catch((e) => { console.error('UK fetch failed', e); return []; }),
    fetchUS().catch((e) => { console.error('US fetch failed', e); return []; }),
    fetchGermany().catch((e) => { console.error('Germany fetch failed', e); return []; }),
  ]);

  const allItems = [...uk, ...us, ...germany];
  console.log(`Fetched ${allItems.length} total items (UK: ${uk.length}, US: ${us.length}, Germany: ${germany.length})`);

  const seenDoc = await db.collection('meta').doc('seenIds').get();
  const seenIds = new Set(seenDoc.exists ? seenDoc.data().ids : []);

  const newItems = allItems.filter((item) => !seenIds.has(item.id));
  console.log(`${newItems.length} new items found`);

  if (newItems.length === 0) {
    console.log('Nothing new. Done.');
    return;
  }

  const subsSnap = await db.collection('subscriptions').get();
  const subscribers = subsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  console.log(`${subscribers.length} subscribed devices`);

  for (const item of newItems) {
    const matchingSubs = subscribers.filter((sub) =>
      matchesTopics(item, sub.topics)
    );

    const payload = JSON.stringify({
      title: `New law: ${item.country}`,
      body: item.title.slice(0, 120),
      url: item.url,
    });

    for (const sub of matchingSubs) {
      try {
        await webpush.sendNotification(sub.subscription, payload);
      } catch (err) {
        console.error(`Push failed for ${sub.id}:`, err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.collection('subscriptions').doc(sub.id).delete();
        }
      }
    }
  }

  const updatedIds = Array.from(
    new Set([...seenIds, ...newItems.map((i) => i.id)])
  ).slice(-2000);

  await db.collection('meta').doc('seenIds').set({ ids: updatedIds });

  console.log('Done.');
}

function matchesTopics(item, topics) {
  if (!topics || topics.length === 0) return true;
  const text = item.title.toLowerCase();
  return topics.some((keyword) => text.includes(keyword.toLowerCase()));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
