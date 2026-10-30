// One-time helper: exchange a Self Client grant code for a refresh token.
// Usage:  node get-token.js <GRANT_CODE>
// Needs ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET (and ZOHO_DC) in .env
import 'dotenv/config';

const code = process.argv[2];
if (!code) {
  console.log('Usage: node get-token.js <GRANT_CODE>');
  process.exit(1);
}
const DC = process.env.ZOHO_DC || 'in';
const params = new URLSearchParams({
  code,
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  grant_type: 'authorization_code',
});
const res = await fetch(`https://accounts.zoho.${DC}/oauth/v2/token?${params}`, { method: 'POST' });
const data = await res.json();
if (data.refresh_token) {
  console.log('\nRefresh token (paste into server/.env as ZOHO_REFRESH_TOKEN):\n');
  console.log(data.refresh_token, '\n');
} else {
  console.log('Failed:', data);
}
