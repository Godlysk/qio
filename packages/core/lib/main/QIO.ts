/**
 * Created by tushar on 2019-05-20
 */

import {Id} from '@qio/prelude/Id'
import {debug} from 'debug'
import {Either, List, Option} from 'standard-data-structures'
import {ICancellable} from 'ts-scheduler'

import {CB} from '../internals/CB'
import {Fiber} from '../internals/Fiber'
import {IRuntime} from '../runtimes/IRuntime'

import {Await} from './Await'
import {Instruction, Tag} from './Instructions'

const D = debug('qio:core')

/**
 * Task represents an [[IO]] that fails with a general failure.
 */
export type Task<A> = QIO<Error, A>
export const Task = <A>(fn: () => A): Task<A> => QIO.try(fn)

/**
 * A [[Task]] that also requires an environment to run.
 */
export type TaskR<A, R> = QIO<Error, A, R>
export const TaskR = <A, R>(fn: (R: R) => A): TaskR<A, R> => QIO.access(fn)

/**
 * UIO represents a c that doesn't require any environment and doesn't ever fail.
 */
export type UIO<A> = QIO<never, A>
export const UIO = <A>(fn: () => A): UIO<A> => QIO.lift(fn)

/**
 * Callback function used in node.js to handle async operations.
 * @ignore
 */
export type NodeJSCallback<A> = (
  err: NodeJS.ErrnoException | null,
  result?: A
) => void

/**
 * @typeparam E1 Possible errors that could be thrown by the program.
 * @typeparam A1 The output of the running the program successfully.
 * @typeparam R1 Environment needed to execute this instance.
 */
export class QIO<E1 = unknown, A1 = unknown, R1 = unknown> {
  /**
   * Safely converts an interuptable IO to non-interuptable one.
   */
  public get asEither(): QIO<never, Either<E1, A1>, R1> {
    return this.map(Either.right).catch(_ => QIO.of(Either.left(_)))
  }
  /**
   * @ignore
   */
  public get asInstruction(): Instruction {
    return this as Instruction
  }

  /**
   * Purely access the environment provided to the program.
   */
  public get env(): QIO<never, R1, R1> {
    return QIO.access(Id)
  }

  /**
   * Returns a [[Fiber]]
   */
  public get fork(): QIO<never, Fiber<E1, A1>, R1> {
    return QIO.env<R1>().zipWithM(QIO.runtime(), (ENV, RTM) =>
      QIO.fork(this.provide(ENV), RTM)
    )
  }

  /**
   * Memorizes the result and executes the IO only once
   */
  public get once(): QIO<never, QIO<E1, A1>, R1> {
    return this.env.chain(env =>
      Await.of<E1, A1>().map(AWT => AWT.set(this.provide(env)).and(AWT.get))
    )
  }

  /**
   * Ignores the result of the c instance
   */
  public get void(): QIO<E1, void, R1> {
    return this.const(undefined)
  }

  /**
   * Creates a new c instance with the provided environment
   */
  public static access<R, A>(cb: (R: R) => A): QIO<never, A, R> {
    return new QIO(Tag.Access, cb)
  }

  /**
   * Effectfully creates a new c instance with the provided environment
   */
  public static accessM<E1, A1, R1, R2>(
    cb: (R: R1) => QIO<E1, A1, R2>
  ): QIO<E1, A1, R1 & R2> {
    return QIO.flatten(QIO.access(cb))
  }

  /**
   * Creates a new c instance with the provided environment by invoking a promise returning function.
   */
  public static accessP<A1, R1>(
    cb: (R: R1) => Promise<A1>
  ): QIO<Error, A1, R1> {
    return QIO.env<R1>().chain(QIO.encaseP(cb))
  }

  /**
   * Converts a [[QIO]] of a function into a [[QIO]] of a value.
   */
  public static ap<E1, A1, R1, A2>(
    qio: QIO<E1, (a: A1) => A2, R1>,
    input: A1
  ): QIO<E1, A2, R1> {
    return qio.map(ab => ab(input))
  }

  /**
   * **NOTE:** The default type is set to `never` because it hard for typescript to infer the types based on how we use `res`.
   * Using `never` will give users compile time error always while using.
   */
  public static asyncIO<E1 = never, A1 = never>(
    cb: (rej: CB<E1>, res: CB<A1>) => ICancellable
  ): QIO<E1, A1> {
    return new QIO(Tag.Async, cb)
  }

  /**
   * Creates a new async [[Task]]
   */
  public static asyncTask<A1 = never>(
    cb: (rej: CB<Error>, res: CB<A1>) => ICancellable
  ): Task<A1> {
    return QIO.asyncIO(cb)
  }

  /**
   * Creates a [[UIO]] using a callback
   */
  public static asyncUIO<A1 = never>(
    cb: (res: CB<A1>) => ICancellable
  ): UIO<A1> {
    return QIO.asyncIO((rej, res) => cb(res))
  }

  /**
   * Calls the provided Effect-full function with the provided arguments.
   * Useful particularly when calling a recursive function with stack safety.
   */
  public static call<E1, A1, R1, T extends unknown[]>(
    fn: (...t: T) => QIO<E1, A1, R1>,
    ...args: T
  ): QIO<E1, A1, R1> {
    return new QIO<E1, A1, R1>(Tag.Call, fn, args)
  }

  /**
   * @ignore
   */
  public static capture<E1, A1, A2>(cb: (A: A1) => Instruction): QIO<E1, A2> {
    return new QIO(Tag.Capture, cb)
  }

  /**
   * @ignore
   */
  public static catch<E1, A1, R1, E2, A2, R2>(
    fa: QIO<E1, A1, R1>,
    aFe: (e: E1) => QIO<E2, A2, R2>
  ): QIO<E2, A2, R1 & R2> {
    return new QIO(Tag.Catch, fa, aFe)
  }

  /**
   * Creates a [[QIO]] using a callback function.
   */
  public static cb<A1>(fn: (cb: (A1: A1) => void) => void): UIO<A1> {
    return QIO.runtime().chain(RTM =>
      QIO.asyncUIO<A1>(res => RTM.scheduler.asap(fn, res))
    )
  }

  /**
   * Serially executes one c after another.
   */
  public static chain<E1, A1, R1, E2, A2, R2>(
    fa: QIO<E1, A1, R1>,
    aFb: (a: A1) => QIO<E2, A2, R2>
  ): QIO<E1 | E2, A2, R1 & R2> {
    return new QIO(Tag.Chain, fa, aFb)
  }

  /**
   * Converts an effect-full function into a function that returns an [[IO]]
   */
  public static encase<E = never, A = never, T extends unknown[] = unknown[]>(
    cb: (...t: T) => A
  ): (...t: T) => QIO<E, A> {
    return (...t) => QIO.lift(() => cb(...t))
  }

  /**
   * Converts a function returning a Promise to a function that returns an [[IO]]
   */
  public static encaseP<A, T extends unknown[]>(
    cb: (...t: T) => Promise<A>
  ): (...t: T) => QIO<Error, A> {
    return (...t) =>
      QIO.runtime().chain(RTM =>
        QIO.asyncIO((rej, res) =>
          RTM.scheduler.asap(() => {
            void cb(...t)
              .then(res)
              .catch(rej)
          })
        )
      )
  }

  /**
   * Creates a [[QIO]] that needs an environment and when resolved outputs the same environment
   */
  public static env<R1 = never>(): QIO<never, R1, R1> {
    return QIO.access<R1, R1>(Id)
  }

  /**
   * Unwraps a c
   */
  public static flatten<E1, A1, R1, E2, A2, R2>(
    qio: QIO<E1, QIO<E2, A2, R2>, R1>
  ): QIO<E1 | E2, A2, R1 & R2> {
    return qio.chain(Id)
  }

  /**
   * Takes in a effect-ful function that return a c and unwraps it.
   * This is an alias to `c.flatten(UIO(fn))`
   *
   * ```ts
   * // An impure function that creates mutable state but also returns a c.
   * const FN = () => {
   *   let count = 0
   *
   *   return c.try(() => count++)
   * }
   * // Using flatten
   * c.flatten(UIO(FN))
   *
   * // Using flattenM
   * c.flattenM(FN)
   * ```
   */
  public static flattenM<E1, A1, R1>(
    qio: () => QIO<E1, A1, R1>
  ): QIO<E1, A1, R1> {
    return QIO.flatten(UIO(qio))
  }

  /**
   * Creates a new [[Fiber]] to run the given [[IO]].
   */
  public static fork<E1, A1>(
    io: QIO<E1, A1>,
    runtime: IRuntime
  ): UIO<Fiber<E1, A1>> {
    return new QIO(Tag.Fork, io, runtime)
  }

  /**
   * Creates an IO from `Either`
   */
  public static fromEither<E, A>(exit: Either<E, A>): QIO<E, A> {
    return exit.fold<QIO<E, A>>(QIO.never(), QIO.reject, QIO.of)
  }

  /**
   * Alternative to ternary operator in typescript that forcefully narrows down the envs
   */
  public static if<E1, R1, E2, R2, A>(
    cond: boolean,
    left: QIO<E1, A, R1>,
    right: QIO<E2, A, R2>
  ): QIO<E1 | E2, A, R1 & R2> {
    return ((cond ? left : right) as unknown) as QIO<E1 | E2, A, R1 & R2>
  }

  /**
   * A different flavour of qio.if]] that takes in functions instead of c instances.
   */
  public static if0<T extends unknown[]>(
    ...args: T
  ): <E1, R1, E2, R2, A>(
    cond: (...args: T) => boolean,
    left: (...args: T) => QIO<E1, A, R1>,
    right: (...args: T) => QIO<E2, A, R2>
  ) => QIO<E1 | E2, A, R1 & R2> {
    return (cond, left, right) =>
      // tslint:disable-next-line: no-any
      cond(...args) ? left(...args) : (right(...args) as any)
  }

  public static lift<E1 = never, A1 = unknown>(cb: () => A1): QIO<E1, A1> {
    return QIO.resume(cb)
  }

  /**
   * Transforms the success value using the specified function
   */
  public static map<E1, A1, R1, A2>(
    fa: QIO<E1, A1, R1>,
    ab: (a: A1) => A2
  ): QIO<E1, A2, R1> {
    return new QIO(Tag.Map, fa, ab)
  }

  /**
   * Returns a [[UIO]] that never resolves.
   */
  public static never(): UIO<never> {
    return new QIO(Tag.Never, undefined)
  }

  /**
   * Simple API to create IOs from a node.js based callback.
   *
   * **Example:**
   * ```ts
   * // c<NodeJS.ErrnoException, number, unknown>
   * const fsOpen = c.node(cb => fs.open('./data.txt', cb))
   * ```
   */
  public static node<A = never>(
    fn: (cb: NodeJSCallback<A>) => void
  ): QIO<NodeJS.ErrnoException, A | undefined> {
    return QIO.runtime().chain(RTM =>
      QIO.asyncIO<NodeJS.ErrnoException, A | undefined>((rej, res) =>
        RTM.scheduler.asap(() => {
          try {
            fn((err, result) => (err === null ? res(result) : rej(err)))
          } catch (e) {
            rej(e as NodeJS.ErrnoException)
          }
        })
      )
    )
  }

  /**
   * Represents a constant value
   */
  public static of<A1>(value: A1): UIO<A1> {
    return new QIO(Tag.Constant, value)
  }

  /**
   * Runs multiple IOs in parallel. Checkout [[QIO.seq]] to run IOs in sequence.
   */
  public static par<E1, A1, R1>(
    ios: Array<QIO<E1, A1, R1>>
  ): QIO<E1, A1[], R1> {
    return ios
      .reduce(
        (a, b) => a.zipWithPar(b, (x, y) => x.prepend(y)),
        QIO.env<R1>().and(QIO.lift<E1, List<A1>>(() => List.empty<A1>()))
      )
      .map(_ => _.asArray.reverse())
  }

  /**
   * Runs at max N IOs in parallel. Checkout [[QIO.par]] to run any number of [[QIO]]s in parallel
   */
  public static parN<E1, A1, R1>(
    N: number,
    ios: Array<QIO<E1, A1, R1>>
  ): QIO<E1, A1[], R1> {
    const itar = (list: Array<QIO<E1, A1, R1>>): QIO<E1, A1[], R1> =>
      QIO.if(
        list.length === 0,
        QIO.of([]),
        QIO.par(list.slice(0, N)).chain(l1 =>
          itar(list.slice(N, list.length)).map(l2 => l1.concat(l2))
        )
      )

    return itar(ios)
  }

  /**
   * Takes in a function that returns a c
   * and converts it to a function that returns an IO by providing it the
   * given env.
   */
  public static pipeEnv<T extends unknown[], E1, A1, R1>(
    fn: (..._: T) => QIO<E1, A1, R1>,
    R: R1
  ): (..._: T) => QIO<E1, A1> {
    return (...T0: T) => fn(...T0).provide(R)
  }

  /**
   * Creates a c that rejects with the provided error
   */
  public static reject<E1>(error: E1): QIO<E1, never> {
    return new QIO(Tag.Reject, error)
  }

  /**
   * @ignore
   */
  public static resume<A1, A2>(cb: (A: A1) => A2): UIO<A2> {
    return new QIO(Tag.Try, cb)
  }

  /**
   * @ignore
   */
  public static resumeM<E1, A1, A2>(cb: (A: A1) => Instruction): QIO<E1, A2> {
    return new QIO(Tag.TryM, cb)
  }

  /**
   * Returns the current runtime in a pure way.
   */
  public static runtime(): UIO<IRuntime> {
    return new QIO(Tag.Runtime)
  }

  /**
   * Executes the provided IOs in sequences and returns their intermediatory results as an Array.
   * Checkout [[QIO.par]] to run multiple IOs in parallel.
   */
  public static seq<E1, A1, R1>(
    ios: Array<QIO<E1, A1, R1>>
  ): QIO<E1, A1[], R1> {
    return ios
      .reduce(
        (fList, f) => fList.chain(list => f.map(value => list.prepend(value))),
        QIO.lift<E1, List<A1>>(() => List.empty<A1>()).addEnv<R1>()
      )
      .map(_ => _.asArray)
  }

  /**
   * Resolves with the provided value after the given time
   */
  public static timeout<A>(value: A, duration: number): QIO<never, A> {
    return QIO.runtime().chain(RTM =>
      QIO.asyncUIO(res => RTM.scheduler.delay(res, duration, value))
    )
  }

  /**
   * Tries to run an effect-full synchronous function and returns a [[Task]] that resolves with the return value of that function
   */
  public static try<A>(cb: () => A): Task<A> {
    return QIO.lift(cb)
  }

  /**
   * Tries to run an function that returns a promise.
   */
  public static tryP<A>(cb: () => Promise<A>): Task<A> {
    return QIO.encaseP(cb)()
  }

  /**
   * Creates an IO from an async/callback based function ie. non cancellable.
   * It tries to make it cancellable by delaying the function call.
   */
  public static uninterruptibleIO<E1 = never, A1 = never>(
    fn: (rej: CB<E1>, res: CB<A1>) => unknown
  ): QIO<E1, A1> {
    return QIO.runtime().chain(RTM =>
      QIO.asyncIO<E1, A1>((rej, res) => RTM.scheduler.asap(fn, rej, res))
    )
  }

  /**
   * Returns a [[UIO]] of void.
   */
  public static void(): UIO<void> {
    return QIO.of(void 0)
  }

  /**
   * Hack: The property $R1 is added to enable stricter checks.
   * More specifically enable contravariant check on R1.
   */
  public readonly $R1?: (r: R1) => void

  /**
   * @ignore
   */
  public constructor(
    /**
     * @ignore
     */
    public readonly tag: Tag,
    /**
     * @ignore
     */
    public readonly i0?: unknown,

    /**
     * @ignore
     */
    public readonly i1?: unknown
  ) {}

  /**
   * Gives access to additional env
   */
  public addEnv<R2>(): QIO<E1, A1, R1 & R2> {
    return QIO.env<R2>().and(this)
  }

  /**
   * Runs the c instances one by one
   */
  public and<E2, A2, R2>(aFb: QIO<E2, A2, R2>): QIO<E1 | E2, A2, R1 & R2> {
    // TODO: can improve PERF by add a new instruction type
    return this.chain(() => aFb)
  }

  /**
   * Captures the exception thrown by the IO and
   */
  public catch<E2, A2, R2>(
    aFb: (e: E1) => QIO<E2, A2, R2>
  ): QIO<E2, A1 | A2, R1 & R2> {
    return QIO.catch(this, aFb)
  }

  /**
   * Chains one [[QIO]] after another.
   */
  public chain<E2, A2, R2>(
    aFb: (a: A1) => QIO<E2, A2, R2>
  ): QIO<E1 | E2, A2, R1 & R2> {
    return QIO.chain(this, aFb)
  }

  /**
   * Ignores the original value of the c and resolves with the provided value
   */
  public const<A2>(a: A2): QIO<E1, A2, R1> {
    return this.and(QIO.of(a))
  }

  /**
   * Delays the execution of the [[QIO]] by the provided time.
   */
  public delay(duration: number): QIO<E1, A1, R1> {
    return QIO.timeout(this, duration).chain(Id)
  }

  /**
   * Like [[QIO.tap]] but takes in an IO instead of a callback.
   */
  public do<E2, R2>(io: QIO<E2, unknown, R2>): QIO<E1 | E2, A1, R1 & R2> {
    return this.chain(_ => io.const(_))
  }

  /**
   * Calls the effect-full function on success of the current c instance.
   */
  public encase<E2 = never, A2 = unknown>(
    fn: (A1: A1) => A2
  ): QIO<E1 | E2, A2, R1> {
    return this.chain(QIO.encase(fn))
  }

  /**
   * Creates a separate [[Fiber]] with a different [[IRuntime]].
   */
  public forkWith(runtime: IRuntime): QIO<never, Fiber<E1, A1>, R1> {
    return QIO.env<R1>().chain(ENV => QIO.fork(this.provide(ENV), runtime))
  }

  /**
   * Applies transformation on the success value of the c.
   */
  public map<A2>(ab: (a: A1) => A2): QIO<E1, A2, R1> {
    return QIO.map(this, ab)
  }

  /**
   * Runs the current IO with the provided IO in parallel.
   */
  public par<E2, A2, R2>(
    that: QIO<E2, A2, R2>
  ): QIO<E1 | E2, [A1, A2], R1 & R2> {
    return this.zipWithPar(that, (a, b) => [a, b])
  }

  /**
   * Provides the current instance of c the required env.
   */
  public provide(r1: R1): QIO<E1, A1> {
    return new QIO(Tag.Provide, this, r1)
  }

  /**
   * Provides the current instance of c the required env that is accessed effect-fully.
   */
  public provideM<E2, R2>(io: QIO<E2, R1, R2>): QIO<E1 | E2, A1, R2> {
    return io.chain(ENV => this.provide(ENV))
  }

  /**
   * Provide only some of the environment
   */
  public provideSome<R0>(fn: (R2: R0) => R1): QIO<E1, A1, R0> {
    return QIO.accessM((r0: R0) => this.provide(fn(r0)))
  }

  /**
   * Provide only some of the environment using an effect
   */
  public provideSomeM<E2, R0>(qio: QIO<E2, R1, R0>): QIO<E1 | E2, A1, R0> {
    return qio.chain(_ => this.provide(_))
  }

  /**
   * Runs two IOs in parallel in returns the result of the first one.
   */
  public race<E2, A2, R2>(
    that: QIO<E2, A2, R2>
  ): QIO<E1 | E2, A1 | A2, R1 & R2> {
    return this.raceWith(
      that,
      (E, F) => F.abort.const(E),
      (E, F) => F.abort.const(E)
    ).chain(E => QIO.fromEither<E1 | E2, A1 | A2>(E))
  }

  /**
   * Executes two c instances in parallel and resolves with the one that finishes first and cancels the other.
   */
  public raceWith<E2, A2, R2, E3, A3, E4, A4>(
    that: QIO<E2, A2, R2>,
    cb1: (exit: Either<E1, A1>, fiber: Fiber<E2, A2>) => QIO<E3, A3>,
    cb2: (exit: Either<E2, A2>, fiber: Fiber<E1, A1>) => QIO<E4, A4>
  ): QIO<E3 | E4, A3 | A4, R1 & R2> {
    return Await.of<E3 | E4, A3 | A4>().chain(done =>
      this.fork.zip(that.fork).chain(([L, R]) => {
        D('zip', 'fiber L', L.id, '& fiber R', R.id)
        const resume1 = L.await.chain(exit => {
          D('zip', 'L cb')

          return Option.isSome(exit)
            ? done.set(cb1(exit.value, R))
            : QIO.of(true)
        })
        const resume2 = R.await.chain(exit => {
          D('zip', 'R cb')

          return Option.isSome(exit)
            ? done.set(cb2(exit.value, L))
            : QIO.of(true)
        })

        return resume1.fork.and(resume2.fork).and(done.get)
      })
    )
  }

  /**
   * Used to perform side-effects but ignore their values
   */
  public tap<E2, R2>(
    io: (A1: A1) => QIO<E2, unknown, R2>
  ): QIO<E1 | E2, A1, R1 & R2> {
    return this.chain(_ => io(_).const(_))
  }

  /**
   * Combine the result of two cs sequentially and return a Tuple
   */
  public zip<E2, A2, R2>(
    that: QIO<E2, A2, R2>
  ): QIO<E1 | E2, [A1, A2], R1 & R2> {
    return this.zipWith(that, (a, b) => [a, b])
  }

  /**
   * Combines the result of two cs and uses a combine function to combine their result
   */
  public zipWith<E2, A2, R2, C>(
    that: QIO<E2, A2, R2>,
    c: (a1: A1, a2: A2) => C
  ): QIO<E1 | E2, C, R1 & R2> {
    return this.chain(a1 => that.map(a2 => c(a1, a2)))
  }

  /**
   * Combines the result of two cs and uses a combine function that returns a c
   */
  public zipWithM<E2, A2, R2, E3, A3, R3>(
    that: QIO<E2, A2, R2>,
    c: (a1: A1, a2: A2) => QIO<E3, A3, R3>
  ): QIO<E1 | E2 | E3, A3, R1 & R2 & R3> {
    return QIO.flatten(this.zipWith(that, c))
  }

  /**
   * Combine two c instances in parallel and use the combine function to combine the result.
   */
  public zipWithPar<E2, A2, R2, C>(
    that: QIO<E2, A2, R2>,
    c: (e1: A1, e2: A2) => C
  ): QIO<E1 | E2, C, R1 & R2> {
    return this.raceWith(
      that,
      (E, F) =>
        E.biMap(
          cause => F.abort.and(QIO.reject(cause)),
          a1 => F.join.map(a2 => c(a1, a2))
        ).reduce<QIO<E1 | E2, C>>(Id, Id),
      (E, F) =>
        E.biMap(
          cause => F.abort.and(QIO.reject(cause)),
          a2 => F.join.map(a1 => c(a1, a2))
        ).reduce<QIO<E1 | E2, C>>(Id, Id)
    )
  }
}
