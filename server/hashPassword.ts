import { hashPassword } from './auth';

const password = process.argv[2] ?? '';
if (password.length < 8) {
  console.error('Usage: npm run auth:hash -- <password-at-least-8-characters>');
  process.exitCode = 1;
} else {
  console.log(hashPassword(password));
}
