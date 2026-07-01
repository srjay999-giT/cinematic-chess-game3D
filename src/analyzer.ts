import { Chess } from 'chess.js'

export type MoveClassification = 'best' | 'brilliant' | 'great' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'missed win' | 'book'

export interface AnalysisNode {
  fen: string
  cp: number
  mate: number | null
  winProbability: number
  classification: MoveClassification | null
}

export type AnalysisResult = AnalysisNode[]

function cpToWinProbability(cp: number): number {
  // Common formula to convert centipawns to win percentage (0 to 100)
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)
}

function classifyMove(prev: AnalysisNode, current: AnalysisNode, isWhite: boolean): MoveClassification {
  if (prev.classification === 'book') return 'book' // First moves can be book

  const prevProb = prev.winProbability
  const curProb = current.winProbability
  const delta = isWhite ? curProb - prevProb : prevProb - curProb

  // Extremely rough heuristics for move classification
  if (delta < -20) {
    if (prev.mate !== null && current.mate === null) return 'missed win'
    return 'blunder'
  }
  if (delta < -10) return 'mistake'
  if (delta < -5) return 'inaccuracy'
  if (delta > 5) return 'great'
  if (delta > 15) return 'brilliant'
  if (delta >= -2) return 'best'
  return 'good'
}

export class Analyzer {
  private worker: Worker | null = null
  private resolvers = new Map<string, (result: { cp: number; mate: number | null }) => void>()
  private isReady = false
  private readyPromise: Promise<void> | null = null

  constructor() {
    this.worker = new Worker('/engine/stockfish.js')
    
    this.readyPromise = new Promise((resolve) => {
      if (!this.worker) return
      this.worker.onmessage = (e) => {
        const msg = e.data
        if (msg === 'uciok') {
          this.isReady = true
          resolve()
        }
        
        if (typeof msg === 'string' && msg.startsWith('info depth')) {
          const depthMatch = msg.match(/depth (\d+)/)
          const scoreMatch = msg.match(/score (cp|mate) (-?\d+)/)
          
          // We look for depth 10 evaluation
          if (depthMatch && parseInt(depthMatch[1]) >= 10 && scoreMatch) {
            const isMate = scoreMatch[1] === 'mate'
            const value = parseInt(scoreMatch[2])
            
            // Assuming this is for the current analysis task
            const resolver = this.resolvers.get('current')
            if (resolver) {
              resolver({ cp: isMate ? (value > 0 ? 10000 : -10000) : value, mate: isMate ? value : null })
              this.resolvers.delete('current')
            }
          }
        }
      }
    })
    
    this.worker.postMessage('uci')
  }

  async waitForReady() {
    if (!this.isReady) {
      await this.readyPromise
    }
  }

  private async evaluatePosition(fen: string): Promise<{ cp: number; mate: number | null }> {
    await this.waitForReady()
    
    return new Promise((resolve) => {
      this.resolvers.set('current', resolve)
      this.worker?.postMessage(`position fen ${fen}`)
      // Depth 10 is fast enough for near-instant client-side analysis
      this.worker?.postMessage('go depth 10')
      
      // Fallback timeout in case engine hangs
      setTimeout(() => {
        if (this.resolvers.has('current')) {
          this.resolvers.delete('current')
          resolve({ cp: 0, mate: null })
        }
      }, 500)
    })
  }

  async analyzeGame(historyFens: string[], onProgress: (index: number, total: number, result: AnalysisNode) => void): Promise<AnalysisResult> {
    const results: AnalysisResult = []
    
    for (let i = 0; i < historyFens.length; i++) {
      const fen = historyFens[i]
      const { cp, mate } = await this.evaluatePosition(fen)
      
      const game = new Chess(fen)
      const isWhiteToMove = game.turn() === 'w'
      // If it's black's turn to move now, the *previous* move was made by white.
      const moveWasMadeByWhite = !isWhiteToMove
      
      // stockfish evaluates from the perspective of the side to move
      // cp > 0 means good for side to move. We normalize it to White's perspective.
      const normalizedCp = isWhiteToMove ? cp : -cp
      let normalizedMate = mate !== null ? (isWhiteToMove ? mate : -mate) : null
      
      const winProbability = cpToWinProbability(normalizedCp)
      
      const node: AnalysisNode = {
        fen,
        cp: normalizedCp,
        mate: normalizedMate,
        winProbability,
        classification: null
      }
      
      if (i <= 5) {
        node.classification = 'book' // First 3 full moves are roughly book
      } else if (i > 0) {
        node.classification = classifyMove(results[i - 1], node, moveWasMadeByWhite)
      }
      
      results.push(node)
      onProgress(i, historyFens.length, node)
    }
    
    return results
  }

  terminate() {
    this.worker?.postMessage('quit')
    this.worker?.terminate()
  }
}
