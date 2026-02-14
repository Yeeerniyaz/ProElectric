import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';

const app = express();

/**
 * Настройка безопасности (Senior Level)
 */
// 1. Helmet скрывает заголовки, по которым хакеры узнают, что это Express
app.use(helmet());

// 2. Ограничитель запросов (Rate Limiter)
// Чтобы никто не мог "задудосить" твой healthcheck
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // Максимум 100 запросов с одного IP
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

/**
 * Запуск веб-сервера
 */
export const startServer = () => {
    // Простой маршрут, чтобы проверить, что сервер отвечает
    app.get('/', (req, res) => {
        res.send('⚡️ ProElectro Bot System is Online');
    });

    // Маршрут Healthcheck для Docker/Portainer
    // Если этот url отдает 200 OK, значит бот жив
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            uptime: process.uptime(), // Сколько секунд работает без перезагрузки
            timestamp: new Date().toISOString()
        });
    });

    // Запуск слушателя
    app.listen(config.server.port, '0.0.0.0', () => {
        console.log(`🌐 [SERVER] Веб-интерфейс запущен на порту ${config.server.port}`);
    });
};