/**
 * Created by tushar on 2019-04-15
 */

import {assert} from 'chai'

import {defaultEnv, DefaultEnv} from '../src/internals/DefaultEnv'
import {IO} from '../src/main/IO'

import {Counter} from './internals/Counter'
import {ForkNRun} from './internals/ForkNRun'
import {IOCollector} from './internals/IOCollector'
import {RejectingIOSpec, ResolvingIOSpec} from './internals/IOSpecification'
import {$} from './internals/ProxyFunction'

const fR = ForkNRun(defaultEnv)
const dC = IOCollector(defaultEnv)

describe('IO', () => {
  describe('once()', () => {
    context('typings', () => {
      it('should return a an IO< IO< A > >', () => {
        interface TestENV {
          name: IO<DefaultEnv, string>
        }
        $(
          (_: IO<TestENV, number>): IO<DefaultEnv, IO<TestENV, number>> =>
            _.once()
        )
      })
    })
    it('should not throw to exit on calling once', () => {
      assert.doesNotThrow(() => IO.of(10).once())
    })
    it('should return an IO that is memoized', () => {
      const counter = Counter()
      const ioP = fR(counter.inc.once())
      const ioC = dC(ioP.timeline.getValue())
      ioC.fork()
      ioC.fork()
      ioC.scheduler.run()

      const actual = counter.getCount()
      const expected = 1
      assert.strictEqual(actual, expected)
    })
  })
  describe('provide()', () => {
    ResolvingIOSpec(() => IO.of(10).provide({}))
    RejectingIOSpec(() => IO.reject(new Error('FAILED')).provide({}))

    it.skip('should pass on the env', () => {
      throw new TypeError('Not implemented')
    })
  })
  describe('access()', () => {
    it('should create an IO[R, A] ', () => {
      interface Console {
        print(str: string): void
      }

      interface HasConsole {
        console: Console
      }

      const Console = () => {
        const strings = new Array<string>()

        return {
          list: () => strings.slice(0),
          print: (str: string) => void strings.push(str)
        }
      }

      const putStrLn = (line: string) =>
        IO.access((_: HasConsole) => _.console.print(line))

      const cons = Console()
      const env: HasConsole = {console: cons}
      ForkNRun(env)(putStrLn('HELLO WORLD'))

      const actual = cons.list()
      const expected = ['HELLO WORLD']

      assert.deepStrictEqual(actual, expected)
    })
    ResolvingIOSpec(() => IO.access(() => 10))
    RejectingIOSpec(() =>
      IO.access(() => {
        throw new Error('FAILED')
      })
    )
  })

  describe('accessM()', () => {
    it('should create an IO[R, A] ', () => {
      interface Console {
        print(str: string): IO<DefaultEnv, void>
      }

      interface HasConsole {
        console: Console
      }

      const Console = () => {
        const strings = new Array<string>()

        return {
          list: () => strings.slice(0),
          print: IO.encase((str: string) => void strings.push(str))
        }
      }

      const putStrLn = (line: string) =>
        IO.accessM((_: HasConsole) => _.console.print(line))

      const cons = Console()
      const env: HasConsole = {console: cons}
      ForkNRun(env)(putStrLn('HELLO WORLD'))

      const actual = cons.list()
      const expected = ['HELLO WORLD']

      assert.deepStrictEqual(actual, expected)
    })
    ResolvingIOSpec(() => IO.accessM(() => IO.of(10)))
    RejectingIOSpec(() =>
      IO.accessM(() => {
        throw new Error('FAILED')
      })
    )
  })
  describe('environment()', () => {
    it('should return the env its being forked with', () => {
      interface Console {
        console: {print(str: string): void}
      }
      const io = IO.environment<Console>()
      const out = new Array<string>()
      const env = {
        console: {
          print: (str: string): void => {
            out.push(str)
          }
        }
      }
      const {timeline} = ForkNRun(env)(io)

      const actual = timeline.list()
      const expected = [['RESOLVE', 1, env]]

      assert.deepStrictEqual(actual, expected)
    })

    ResolvingIOSpec(() => IO.environment())
  })
})