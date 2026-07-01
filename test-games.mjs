import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { Chess } from 'chess.js';

async function run() {
  console.log('Starting dev server...');
  const devServer = spawn('npm', ['run', 'dev'], { stdio: 'pipe', cwd: '/Users/keshargadage/CHESS' });
  
  await new Promise(r => setTimeout(r, 4000)); // Wait for server to start

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  
  let failures = 0;
  
  try {
    for (let i = 1; i <= 20; i++) {
      console.log(`\n--- Starting Game ${i} ---`);
      const page = await context.newPage();
      await page.goto('http://localhost:5173');
      
      // Enter showcase
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(500);
      
      // Enter experience
      await page.locator('.showcase-play').click();
      await page.waitForTimeout(2500);
      
      // Set to 1 min timer to test clock
      const timeButton = page.locator('button:text-is("1")');
      if (await timeButton.count() > 0) {
        await timeButton.click();
      }
      
      // Start match
      await page.locator('#begin-match').click();
      await page.waitForTimeout(500);
      
      let moves = 0;
      let gameActive = true;
      let noMoveCounter = 0;
      
      while (gameActive && moves < 40) { // Limit to 40 ply to speed it up
        const gameStateStr = await page.evaluate(() => document.documentElement.dataset.gameState);
        if (!gameStateStr) {
          await page.waitForTimeout(200);
          continue;
        }
        
        const state = JSON.parse(gameStateStr);
        
        if (state.phase === 'gameOver') {
          console.log(`Game ${i} ended normally: ${state.result}`);
          gameActive = false;
          break;
        }
        
        if (state.phase === 'playing' && !state.engineThinking && state.turn === state.playerColor) {
          // Player's turn
          const game = new Chess(state.fen);
          const legalMoves = game.moves({ verbose: true });
          
          if (legalMoves.length > 0) {
            const move = legalMoves[Math.floor(Math.random() * legalMoves.length)];
            // Emit custom event to play move instantly
            await page.evaluate((m) => {
              document.dispatchEvent(new CustomEvent('codex:move', { detail: { from: m.from, to: m.to, promotion: m.promotion } }));
            }, move);
            moves++;
            noMoveCounter = 0;
            console.log(`Game ${i}: Player played ${move.san}`);
            await page.waitForTimeout(100); // Small wait to allow React to process
          }
        } else {
          // Waiting for AI or transition
          noMoveCounter++;
          if (noMoveCounter > 50) { // 50 * 200ms = 10s without player turn or game over
            console.error(`Game ${i} frozen! AI never responded or player couldn't move.`);
            failures++;
            gameActive = false;
          }
          await page.waitForTimeout(200);
        }
      }
      
      if (moves >= 40) {
        console.log(`Game ${i} reached 40 ply successfully without freezing.`);
      }
      
      await page.close();
    }
  } catch (err) {
    console.error('Test error:', err);
    failures++;
  } finally {
    await browser.close();
    devServer.kill();
    
    if (failures === 0) {
      console.log('\nSUCCESS! 20 games played with zero frozen turns.');
    } else {
      console.error(`\nFAILED! ${failures} games froze.`);
    }
  }
}

run();
