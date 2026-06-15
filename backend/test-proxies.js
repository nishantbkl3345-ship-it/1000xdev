require('dotenv').config();

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxies = Object.keys(process.env)
  .filter((key) => /^PROXY_\d+$/.test(key))
  .map((key) => process.env[key])
  .filter(Boolean);

console.log(`Found ${proxies.length} proxies\n`);

async function testProxy(proxy, index) {
  try {
    const agent = new HttpsProxyAgent(proxy);

    console.log(`\n[PROXY ${index + 1}]`);

    // Check outgoing IP
    const ipRes = await axios.get(
      'https://api.ipify.org?format=json',
      {
        httpsAgent: agent,
        timeout: 15000,
      }
    );

    console.log('IP:', ipRes.data.ip);

    // Check Meesho access
    const meeshoRes = await axios.get(
      'https://www.meesho.com',
      {
        httpsAgent: agent,
        timeout: 15000,
        validateStatus: () => true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        },
      }
    );

    console.log('Meesho status:', meeshoRes.status);

    const html =
      typeof meeshoRes.data === 'string'
        ? meeshoRes.data.slice(0, 300)
        : '';

    if (
      html.includes('Access Denied') ||
      html.includes('errors.edgesuite.net')
    ) {
      console.log('❌ Akamai blocked');
    } else if (meeshoRes.status === 200) {
      console.log('✅ Meesho accessible');
    } else {
      console.log('⚠ Unexpected response');
    }
  } catch (err) {
    console.log('❌ Failed:', err.message);
  }
}

(async () => {
  for (let i = 0; i < proxies.length; i++) {
    await testProxy(proxies[i], i);
  }
})();
