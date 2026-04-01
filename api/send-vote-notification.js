// api/send-vote-notification.js
// Sends a confirmation email when a user opts in for tool launch notifications

const TOOL_NAMES = {
  'todo':      'To-Do & Notes Tracker',
  'sleep':     'Sleep & Brain Fog Tracker',
  'pet':       'Did I Feed the Pet?',
  'travel':    'Travel Planner',
  'doctor':    'Doctor Visit & Medication Tracker',
  'passwords': 'Password Collector',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, tool } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const toolName = TOOL_NAMES[tool] || 'the tool you voted for';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'The Artifacts Lab <noreply@theartifactslab.com>',
        to: email,
        subject: `You're on the list — ${toolName}`,
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0B0F1A;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0B0F1A;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111827;border:1px solid #2A3B55;border-radius:16px;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #2A3B55;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:36px;height:36px;background:rgba(212,146,10,0.12);border:1px solid #D4920A;border-radius:8px;text-align:center;vertical-align:middle;font-size:18px;">
                    &#9879;&#65039;
                  </td>
                  <td style="padding-left:10px;font-family:Georgia,serif;font-size:16px;font-weight:700;color:#F5A623;">
                    The Artifacts Lab
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <p style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#D4920A;">
                You're on the list
              </p>
              <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:26px;font-weight:700;color:#E8EDF5;line-height:1.2;">
                ${toolName}
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#9BAAC4;line-height:1.7;">
                Got it — you'll be the first to know when <strong style="color:#E8EDF5;">${toolName}</strong> launches. We build in order of demand, and your vote counts.
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#9BAAC4;line-height:1.7;">
                In the meantime, the tools that are already live are free to try — no account needed for the free tier.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td style="background:#D4920A;border-radius:10px;padding:13px 28px;">
                    <a href="https://theartifactslab.com/tools.html"
                       style="color:#0B0F1A;font-size:15px;font-weight:700;text-decoration:none;display:block;">
                      See the live tools &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <hr style="border:none;border-top:1px solid #2A3B55;margin:0 0 24px;">

              <p style="margin:0;font-family:'Courier New',monospace;font-size:11px;color:#5A6A8A;letter-spacing:0.06em;">
                You're receiving this because you voted on the roadmap at theartifactslab.com.
                No spam, ever. &mdash; The Artifacts Lab
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'Email send failed' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-vote-notification error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
