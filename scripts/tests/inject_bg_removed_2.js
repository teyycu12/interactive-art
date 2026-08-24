import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({
    type: 'CLIENT_JOIN',
    name: '宇宙探險家',
    avatar: {
      source: 'CV',
      textures: {
        head: '/assets/gen/22222222222222222222222222222222/head.webp',
        torso: '/assets/gen/22222222222222222222222222222222/torso.webp',
        legs: '/assets/gen/22222222222222222222222222222222/legs.webp'
      },
      fallbackColors: {
        skin: '#F4C08A', hair: '#4A2C1A', torso: '#8FA05E', legs: '#B7A98A'
      }
    }
  }));
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});
