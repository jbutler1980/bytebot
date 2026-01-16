import {
  Button,
  Coordinates,
  Press,
  ComputerToolUseContentBlock,
  ToolResultContentBlock,
  MessageContentType,
  isScreenshotToolUseBlock,
  isCursorPositionToolUseBlock,
  isMoveMouseToolUseBlock,
  isTraceMouseToolUseBlock,
  isClickMouseToolUseBlock,
  isPressMouseToolUseBlock,
  isDragMouseToolUseBlock,
  isScrollToolUseBlock,
  isTypeKeysToolUseBlock,
  isPressKeysToolUseBlock,
  isTypeTextToolUseBlock,
  isWaitToolUseBlock,
  isApplicationToolUseBlock,
  isPasteTextToolUseBlock,
  isReadFileToolUseBlock,
} from '@bytebot/shared';
import { Logger } from '@nestjs/common';

/**
 * Fallback desktop URL for legacy mode (Phase 6 not deployed)
 */
const FALLBACK_DESKTOP_URL = process.env.BYTEBOT_DESKTOP_BASE_URL as string;

/**
 * Phase 4: Error class for execution surface constraint violations
 */
export class DesktopRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopRequiredError';
  }
}

/**
 * Get the desktop URL to use for API calls
 * Phase 4: Now validates desktop requirement before falling back
 * @param desktopUrl - Per-task desktop URL from task controller (Phase 6)
 * @param requiresDesktop - Whether this task requires a desktop pod (Phase 4)
 * @returns The URL to use for desktop API calls
 * @throws DesktopRequiredError if desktop is required but not available
 */
function getDesktopUrl(desktopUrl?: string, requiresDesktop?: boolean): string {
  // If desktop is explicitly required, we must have a per-task URL
  if (requiresDesktop && !desktopUrl) {
    throw new DesktopRequiredError(
      'Task requires desktop but no desktop pod is assigned. ' +
      'Ensure task has a desktop pod before executing desktop tools.',
    );
  }

  // Log warning when falling back (but allow for non-required tasks)
  if (!desktopUrl && FALLBACK_DESKTOP_URL) {
    console.warn(
      '[Phase 4 Warning] Using fallback desktop URL. ' +
      'For production, ensure desktop pods are properly assigned.',
    );
  }

  return desktopUrl || FALLBACK_DESKTOP_URL;
}

/**
 * Context for action execution (Phase 6.4)
 */
export interface ActionContext {
  taskId: string;
  desktopUrl?: string;
  // Phase 4: Execution surface constraint
  requiresDesktop?: boolean;
  onAction?: (action: ActionResult) => void;
}

/**
 * Result of an action execution (for logging)
 */
export interface ActionResult {
  actionType: string;
  success: boolean;
  durationMs: number;
  coordinates?: { x: number; y: number };
  errorMessage?: string;
  input?: Record<string, unknown>;
}

/**
 * Handle computer tool use with optional per-task context
 * @param block - The computer tool use content block from LLM
 * @param logger - Logger instance
 * @param context - Optional action context with per-task desktop URL (Phase 6.4)
 */
export async function handleComputerToolUse(
  block: ComputerToolUseContentBlock,
  logger: Logger,
  context?: ActionContext,
): Promise<ToolResultContentBlock> {
  // Phase 4: Pass requiresDesktop to enable fail-fast validation
  const desktopUrl = getDesktopUrl(context?.desktopUrl, context?.requiresDesktop);
  logger.debug(
    `Handling computer tool use: ${block.name}, tool_use_id: ${block.id}`,
  );

  // Helper to report action results
  const reportAction = (result: ActionResult) => {
    if (context?.onAction) {
      context.onAction(result);
    }
  };

  if (isScreenshotToolUseBlock(block)) {
    logger.debug('Processing screenshot request');
    const startTime = Date.now();
    try {
      logger.debug('Taking screenshot');
      const image = await screenshot(desktopUrl);
      logger.debug('Screenshot captured successfully');

      reportAction({
        actionType: 'screenshot',
        success: true,
        durationMs: Date.now() - startTime,
      });

      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Image,
            source: {
              data: image,
              media_type: 'image/png',
              type: 'base64',
            },
          },
        ],
      };
    } catch (error) {
      logger.error(`Screenshot failed: ${error.message}`, error.stack);
      reportAction({
        actionType: 'screenshot',
        success: false,
        durationMs: Date.now() - startTime,
        errorMessage: error.message,
      });
      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: 'ERROR: Failed to take screenshot',
          },
        ],
        is_error: true,
      };
    }
  }

  if (isCursorPositionToolUseBlock(block)) {
    logger.debug('Processing cursor position request');
    const startTime = Date.now();
    try {
      logger.debug('Getting cursor position');
      const position = await cursorPosition(desktopUrl);
      logger.debug(`Cursor position obtained: ${position.x}, ${position.y}`);

      reportAction({
        actionType: 'cursor_position',
        success: true,
        durationMs: Date.now() - startTime,
        coordinates: position,
      });

      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: `Cursor position: ${position.x}, ${position.y}`,
          },
        ],
      };
    } catch (error) {
      logger.error(
        `Getting cursor position failed: ${error.message}`,
        error.stack,
      );
      reportAction({
        actionType: 'cursor_position',
        success: false,
        durationMs: Date.now() - startTime,
        errorMessage: error.message,
      });
      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: 'ERROR: Failed to get cursor position',
          },
        ],
        is_error: true,
      };
    }
  }

  const startTime = Date.now();
  let actionType = block.name;
  let actionCoordinates: { x: number; y: number } | undefined;

  try {
    if (isMoveMouseToolUseBlock(block)) {
      actionType = 'computer_move_mouse';
      actionCoordinates = block.input.coordinates;
      await moveMouse(block.input, desktopUrl);
    }
    if (isTraceMouseToolUseBlock(block)) {
      actionType = 'computer_trace_mouse';
      await traceMouse(block.input, desktopUrl);
    }
    if (isClickMouseToolUseBlock(block)) {
      actionType = 'computer_click_mouse';
      actionCoordinates = block.input.coordinates;
      await clickMouse(block.input, desktopUrl);
    }
    if (isPressMouseToolUseBlock(block)) {
      actionType = 'computer_press_mouse';
      actionCoordinates = block.input.coordinates;
      await pressMouse(block.input, desktopUrl);
    }
    if (isDragMouseToolUseBlock(block)) {
      actionType = 'computer_drag_mouse';
      await dragMouse(block.input, desktopUrl);
    }
    if (isScrollToolUseBlock(block)) {
      actionType = 'computer_scroll';
      actionCoordinates = block.input.coordinates;
      await scroll(block.input, desktopUrl);
    }
    if (isTypeKeysToolUseBlock(block)) {
      actionType = 'computer_type_keys';
      await typeKeys(block.input, desktopUrl);
    }
    if (isPressKeysToolUseBlock(block)) {
      actionType = 'computer_press_keys';
      await pressKeys(block.input, desktopUrl);
    }
    if (isTypeTextToolUseBlock(block)) {
      actionType = 'computer_type_text';
      await typeText(block.input, desktopUrl);
    }
    if (isPasteTextToolUseBlock(block)) {
      actionType = 'computer_paste_text';
      await pasteText(block.input, desktopUrl);
    }
    if (isWaitToolUseBlock(block)) {
      actionType = 'computer_wait';
      await wait(block.input, desktopUrl);
    }
    if (isApplicationToolUseBlock(block)) {
      actionType = 'computer_application';
      await application(block.input, desktopUrl);
    }
    if (isReadFileToolUseBlock(block)) {
      actionType = 'computer_read_file';
      logger.debug(`Reading file: ${block.input.path}`);
      const result = await readFile(block.input, desktopUrl);

      reportAction({
        actionType,
        success: result.success,
        durationMs: Date.now() - startTime,
        input: { path: block.input.path },
      });

      if (result.success && result.data) {
        // Return document content block
        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Document,
              source: {
                type: 'base64',
                media_type: result.mediaType || 'application/octet-stream',
                data: result.data,
              },
              name: result.name || 'file',
              size: result.size,
            },
          ],
        };
      } else {
        // Return error message
        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Text,
              text: result.message || 'Error reading file',
            },
          ],
          is_error: true,
        };
      }
    }

    // Report successful action
    reportAction({
      actionType,
      success: true,
      durationMs: Date.now() - startTime,
      coordinates: actionCoordinates,
    });

    let image: string | null = null;
    try {
      // Wait before taking screenshot to allow UI to settle
      const delayMs = 750; // 750ms delay
      logger.debug(`Waiting ${delayMs}ms before taking screenshot`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      logger.debug('Taking screenshot');
      image = await screenshot(desktopUrl);
      logger.debug('Screenshot captured successfully');
    } catch (error) {
      logger.error('Failed to take screenshot', error);
    }

    logger.debug(`Tool execution successful for tool_use_id: ${block.id}`);
    const toolResult: ToolResultContentBlock = {
      type: MessageContentType.ToolResult,
      tool_use_id: block.id,
      content: [
        {
          type: MessageContentType.Text,
          text: 'Tool executed successfully',
        },
      ],
    };

    if (image) {
      toolResult.content.push({
        type: MessageContentType.Image,
        source: {
          data: image,
          media_type: 'image/png',
          type: 'base64',
        },
      });
    }

    return toolResult;
  } catch (error) {
    logger.error(
      `Error executing ${block.name} tool: ${error.message}`,
      error.stack,
    );

    // Report failed action
    reportAction({
      actionType,
      success: false,
      durationMs: Date.now() - startTime,
      coordinates: actionCoordinates,
      errorMessage: error.message,
    });

    return {
      type: MessageContentType.ToolResult,
      tool_use_id: block.id,
      content: [
        {
          type: MessageContentType.Text,
          text: `Error executing ${block.name} tool: ${error.message}`,
        },
      ],
      is_error: true,
    };
  }
}

/**
 * Action functions - all accept optional desktopUrl for Phase 6.4 per-task routing
 */

async function moveMouse(
  input: { coordinates: Coordinates },
  desktopUrl: string,
): Promise<void> {
  const { coordinates } = input;
  console.log(
    `Moving mouse to coordinates: [${coordinates.x}, ${coordinates.y}]`,
  );

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'move_mouse',
        coordinates,
      }),
    });
  } catch (error) {
    console.error('Error in move_mouse action:', error);
    throw error;
  }
}

async function traceMouse(
  input: {
    path: Coordinates[];
    holdKeys?: string[];
  },
  desktopUrl: string,
): Promise<void> {
  const { path, holdKeys } = input;
  console.log(
    `Tracing mouse to path: ${path} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
  );

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'trace_mouse',
        path,
        holdKeys,
      }),
    });
  } catch (error) {
    console.error('Error in trace_mouse action:', error);
    throw error;
  }
}

async function clickMouse(
  input: {
    coordinates?: Coordinates;
    button: Button;
    holdKeys?: string[];
    clickCount: number;
  },
  desktopUrl: string,
): Promise<void> {
  const { coordinates, button, holdKeys, clickCount } = input;
  console.log(
    `Clicking mouse ${button} ${clickCount} times ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}] ` : ''} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
  );

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'click_mouse',
        coordinates,
        button,
        holdKeys: holdKeys && holdKeys.length > 0 ? holdKeys : undefined,
        clickCount,
      }),
    });
  } catch (error) {
    console.error('Error in click_mouse action:', error);
    throw error;
  }
}

async function pressMouse(
  input: {
    coordinates?: Coordinates;
    button: Button;
    press: Press;
  },
  desktopUrl: string,
): Promise<void> {
  const { coordinates, button, press } = input;
  console.log(
    `Pressing mouse ${button} ${press} ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}]` : ''}`,
  );

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'press_mouse',
        coordinates,
        button,
        press,
      }),
    });
  } catch (error) {
    console.error('Error in press_mouse action:', error);
    throw error;
  }
}

async function dragMouse(
  input: {
    path: Coordinates[];
    button: Button;
    holdKeys?: string[];
  },
  desktopUrl: string,
): Promise<void> {
  const { path, button, holdKeys } = input;
  console.log(
    `Dragging mouse to path: ${path} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
  );

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'drag_mouse',
        path,
        button,
        holdKeys: holdKeys && holdKeys.length > 0 ? holdKeys : undefined,
      }),
    });
  } catch (error) {
    console.error('Error in drag_mouse action:', error);
    throw error;
  }
}

async function scroll(
  input: {
    coordinates?: Coordinates;
    direction: 'up' | 'down' | 'left' | 'right';
    scrollCount: number;
    holdKeys?: string[];
  },
  desktopUrl: string,
): Promise<void> {
  const { coordinates, direction, scrollCount, holdKeys } = input;
  console.log(
    `Scrolling ${direction} ${scrollCount} times ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}]` : ''}`,
  );

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'scroll',
        coordinates,
        direction,
        scrollCount,
        holdKeys: holdKeys && holdKeys.length > 0 ? holdKeys : undefined,
      }),
    });
  } catch (error) {
    console.error('Error in scroll action:', error);
    throw error;
  }
}

async function typeKeys(
  input: {
    keys: string[];
    delay?: number;
  },
  desktopUrl: string,
): Promise<void> {
  const { keys, delay } = input;
  console.log(`Typing keys: ${keys}`);

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'type_keys',
        keys,
        delay,
      }),
    });
  } catch (error) {
    console.error('Error in type_keys action:', error);
    throw error;
  }
}

async function pressKeys(
  input: {
    keys: string[];
    press: Press;
  },
  desktopUrl: string,
): Promise<void> {
  const { keys, press } = input;
  console.log(`Pressing keys: ${keys}`);

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'press_keys',
        keys,
        press,
      }),
    });
  } catch (error) {
    console.error('Error in press_keys action:', error);
    throw error;
  }
}

async function typeText(
  input: {
    text: string;
    delay?: number;
  },
  desktopUrl: string,
): Promise<void> {
  const { text, delay } = input;
  console.log(`Typing text: ${text}`);

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'type_text',
        text,
        delay,
      }),
    });
  } catch (error) {
    console.error('Error in type_text action:', error);
    throw error;
  }
}

async function pasteText(
  input: { text: string },
  desktopUrl: string,
): Promise<void> {
  const { text } = input;
  console.log(`Pasting text: ${text}`);

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'paste_text',
        text,
      }),
    });
  } catch (error) {
    console.error('Error in paste_text action:', error);
    throw error;
  }
}

async function wait(
  input: { duration: number },
  desktopUrl: string,
): Promise<void> {
  const { duration } = input;
  console.log(`Waiting for ${duration}ms`);

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'wait',
        duration,
      }),
    });
  } catch (error) {
    console.error('Error in wait action:', error);
    throw error;
  }
}

async function cursorPosition(desktopUrl: string): Promise<Coordinates> {
  console.log('Getting cursor position');

  try {
    const response = await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'cursor_position',
      }),
    });

    const data = await response.json();
    return { x: data.x, y: data.y };
  } catch (error) {
    console.error('Error in cursor_position action:', error);
    throw error;
  }
}

async function screenshot(desktopUrl: string): Promise<string> {
  console.log('Taking screenshot');

  try {
    const requestBody = {
      action: 'screenshot',
    };

    const response = await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Failed to take screenshot: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.image) {
      throw new Error('Failed to take screenshot: No image data received');
    }

    return data.image; // Base64 encoded image
  } catch (error) {
    console.error('Error in screenshot action:', error);
    throw error;
  }
}

async function application(
  input: { application: string },
  desktopUrl: string,
): Promise<void> {
  const { application: app } = input;
  console.log(`Opening application: ${app}`);

  try {
    await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'application',
        application: app,
      }),
    });
  } catch (error) {
    console.error('Error in application action:', error);
    throw error;
  }
}

async function readFile(
  input: { path: string },
  desktopUrl: string,
): Promise<{
  success: boolean;
  data?: string;
  name?: string;
  size?: number;
  mediaType?: string;
  message?: string;
}> {
  const { path } = input;
  console.log(`Reading file: ${path}`);

  try {
    const response = await fetch(`${desktopUrl}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'read_file',
        path,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error in read_file action:', error);
    return {
      success: false,
      message: `Error reading file: ${error.message}`,
    };
  }
}

/**
 * Write file to desktop - also updated for Phase 6.4
 */
export async function writeFile(
  input: {
    path: string;
    content: string;
  },
  desktopUrl?: string,
): Promise<{ success: boolean; message?: string }> {
  const { path, content } = input;
  const url = getDesktopUrl(desktopUrl);
  console.log(`Writing file: ${path}`);

  try {
    // Content is always base64 encoded
    const base64Data = content;

    const response = await fetch(`${url}/computer-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'write_file',
        path,
        data: base64Data,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to write file: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error in write_file action:', error);
    return {
      success: false,
      message: `Error writing file: ${error.message}`,
    };
  }
}
