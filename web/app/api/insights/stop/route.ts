import { engine } from '@/lib/engine';
export const POST = () => engine('/insights/stop', { method: 'POST', body: {} });
