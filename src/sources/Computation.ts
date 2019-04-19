import {Cancel, IScheduler} from 'ts-scheduler'

import {FIO} from '../internals/FIO'
import {REJ} from '../internals/REJ'
import {RES} from '../internals/RES'

enum IOStatus {
  FORKED,
  RESOLVED,
  REJECTED,
  CANCELLED
}

/**
 * @ignore
 */
export class Computation<R, A> implements FIO<R, A> {
  public constructor(
    private readonly cmp: (
      sh: IScheduler,
      env: R,
      rej: REJ,
      res: RES<A>
    ) => void | Cancel
  ) {}

  public fork(sh: IScheduler, env: R, rej: REJ, res: RES<A>): Cancel {
    const cancellations = new Array<Cancel>()
    let status = IOStatus.FORKED
    const onRej: REJ = e => {
      status = IOStatus.REJECTED
      rej(e)
    }

    const onRes: RES<A> = a => {
      status = IOStatus.RESOLVED
      res(a)
    }

    cancellations.push(
      sh.asap(() => {
        try {
          const cancel = this.cmp(sh, env, onRej, onRes)
          if (typeof cancel === 'function') {
            cancellations.push(cancel)
          }
        } catch (e) {
          rej(e as Error)
        }
      })
    )

    return () => {
      if (status === IOStatus.FORKED) {
        status = IOStatus.CANCELLED
        cancellations.forEach(_ => _())
      }
    }
  }
}
