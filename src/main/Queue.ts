import {immutable, LinkedListNode} from 'standard-data-structures'
import {List} from 'standard-data-structures/src/immutable/list'

import {PureMutableList} from '../internals/PureMutableList'

import {Await} from './Await'
import {FIO, NoEnv, UIO} from './FIO'
import {FStream} from './FStream'

/**
 * Queue Data Structure
 */
export class Queue<A = never> {
  /**
   * Returns the Queue as an array
   */
  public get asArray(): UIO<A[]> {
    return this.Q.asArray
  }

  public get length(): UIO<number> {
    return this.Q.length
  }

  /**
   * Returns the current size of the queue
   */
  public get size(): UIO<number> {
    return this.Q.length
  }

  /**
   * Pulls an item from the queue
   */
  public get take(): UIO<A> {
    return this.Q.shift.chain(sz =>
      sz !== undefined
        ? FIO.of(sz)
        : FIO.flatten(
            Await.of<never, A>().chain(
              FIO.encase(await => this.T.add(await).and(await.get))
            )
          )
    )
  }

  /**
   * Creates a new bounded Queue
   */
  public static bounded<A>(capacity: number): UIO<Queue<A>> {
    return PureMutableList.of<A>().zipWith(
      PureMutableList.of<Await<never, A>>(),
      (Q, T) => new Queue(capacity, Q, T)
    )
  }

  /**
   * Creates a queue which is theoretically unbounded.
   */
  public static unbounded<A>(): UIO<Queue<A>> {
    return Queue.bounded(Number.MAX_SAFE_INTEGER)
  }

  private constructor(
    public readonly capacity: number,
    private readonly Q: PureMutableList<A>,
    private readonly T: PureMutableList<Await<never, A>>
  ) {}

  /**
   * Inserts an item into the queue
   */
  public offer(a: A): UIO<LinkedListNode<A>> {
    return this.Q.add(a).tap(_ => this.setAwaited(_.value))
  }

  /**
   * Adds all the provided items into the queue
   */
  public offerAll(...a: A[]): UIO<Array<LinkedListNode<A>>> {
    return FIO.seq(a.map(_ => this.offer(_)))
  }

  /**
   * Resolves after `n` items are available in the queue.
   */
  public takeN(n: number): UIO<A[]> {
    const itar = (i: number, list: List<A>): UIO<List<A>> =>
      FIO.if(
        i === n,
        FIO.of(list),
        this.take.chain(_ => itar(i + 1, list.prepend(_)))
      )

    return itar(0, List.empty).map(_ => _.asArray)
  }

  private setAwaited(value: A): UIO<boolean[]> {
    const itar = (list: List<UIO<boolean>>): UIO<List<UIO<boolean>>> =>
      this.T.shift.chain(_ =>
        _ === undefined
          ? FIO.of(list)
          : itar(list.prepend(_.set(FIO.of(value))))
      )

    return itar(immutable.List.empty).chain(_ =>
      FIO.seq(_.asArray).tap(() => (!_.isEmpty ? this.Q.shift : FIO.void()))
    )
  }

  /**
   * Converts a queue into a [[FStream]]
   */
  public get asStream(): FStream<never, A, NoEnv> {
    return FStream.produce(this.take)
  }
}