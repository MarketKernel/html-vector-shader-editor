// Zoom and pan. Panning works from any tool too: Space or the middle button (view.ts).

import { app } from '../app';
import type { Tool } from './tool';

export const zoomTool: Tool = {
  id: 'zoom',
  label: 'Масштаб',
  key: 'Z',
  icon: 'zoom',
  hint: 'Клик — приблизить, Alt+клик — отдалить; ⌘/Ctrl+колесо — к курсору',
  cursor: (e) => (e?.alt ? 'zoom-out' : 'zoom-in'),
  down(e) {
    app.view.zoomStep(e.alt ? -1 : 1, e.sx, e.sy);
  },
};

export const panTool: Tool = {
  id: 'pan',
  label: 'Рука',
  key: 'H',
  icon: 'pan',
  hint: 'Протяжка двигает вид; пробел или средняя кнопка — из любого инструмента',
  cursor: () => 'grab',
};
