import { createApp } from './app.js';

try {
  const app = await createApp('/data');
  await app.listen({ host: '0.0.0.0', port: 3000 });
} catch (error) {
  console.error('Could not start the LaTeX workspace', error);
  process.exitCode = 1;
}
