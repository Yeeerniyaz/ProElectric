import express from 'express';
import { config } from './config.js';

const app = express();
const PORT = config.server.port || 3000;

/**
 * Инициализация веб-сервера для Healthcheck и мониторинга
 */
export const startServer = () => {
    // Простой эндпоинт для проверки статуса
    app.get('/health', (req, res) => {
        res.status(200).json({ 
            status: 'ok', 
            uptime: process.uptime(),
            message: 'ProElectro Bot is running' 
        });
    });

    // Маршрут по умолчанию
    app.get('/', (req, res) => {
        res.send('⚡️ ProElectro System is Online');
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 [SERVER] Healthcheck доступен по порту ${PORT}`);
    });
};