/** Snapshot ownership before awaiting: a late teardown must never consume another case's resources. */
export async function drainCleanups(stack: Array<() => void | Promise<unknown>>): Promise<void> {
  const owned = stack.splice(0).reverse()
  const errors: unknown[] = []
  for (const cleanup of owned) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'test fixture cleanup failed')
}
