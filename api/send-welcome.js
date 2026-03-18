export default async function handler(req, res) {
  // Allow browser calls
  res.setHeader('Access-Control-Allow-Origin', 'https://www.theartifactslab.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from:        'The Artifacts Lab <noreply@theartifactslab.com>',
        to:          [email],
        subject:     "You're in — welcome to The Artifacts Lab ⚗️",
        template_id: '025f2080-64c0-40b2-8f04-f7c235028ae7',
      }),
    });

    const data = await response.json();
    return res.status(200).json({ sent: true, data });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
