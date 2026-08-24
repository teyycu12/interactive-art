import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({
    type: 'CLIENT_JOIN',
    name: 'TestLego',
    avatar: {
      source: 'CV',
      textures: {
        head: '/assets/gen/12345678901234567890123456789012/head.png',
        torso: '/assets/gen/12345678901234567890123456789012/torso.png',
        legs: '/assets/gen/12345678901234567890123456789012/legs.png'
      },
      fallbackColors: {
        skin: '#F4C08A', hair: '#4A2C1A', torso: '#8FA05E', legs: '#B7A98A'
      }
    }
  }));
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
  setTimeout(() => ws.close(), 10000);
});
