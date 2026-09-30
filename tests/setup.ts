import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.MONGODB_DB = process.env.MONGODB_DB_TEST ?? 'hedwig_test';
