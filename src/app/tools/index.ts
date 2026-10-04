import { penTool } from './pen';
import { selectTool } from './select';
import { ellipseTool, lineTool, rectTool } from './shapes';
import type { Tool } from './tool';
import { panTool, zoomTool } from './view-tools';

export const TOOLS: Tool[] = [selectTool, rectTool, ellipseTool, lineTool, penTool, zoomTool, panTool];
