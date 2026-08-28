import { useQuery } from '@tanstack/react-query'
import { meQuery, tracesQuery } from '../api/queries.ts'
import { ApiError } from '../errors/api-error.ts'
import { LoginPage } from './login.tsx'

/**
 * The trace list — every row here was written by a real `/v1/panels/{id}/evaluate` call
 * (P4). The console cannot create one; it is the read half of the loop, which is exactly
 * what M0 set out to show end to end.
 *
 * The signed-out case renders the login form rather than redirecting, because a redirect at
 * M0 would be routing machinery standing in for the thing being proved. The guard is on the
 * SERVER — `sessionAuth` on `/internal/*` — and this branch is only what the browser does
 * about it.
 */

const Failure = ({ error }: { error: unknown }) => {
  // Every failure from this API carries a taxonomy code, and the code decides what the user
  // is told and what they are offered. Anything else is not from us.
  if (!(error instanceof ApiError)) {
    return <p role="alert">Could not reach the API.</p>
  }
  const { title, detail, recovery } = error.treatment
  return (
    <section role="alert">
      <h3>{title}</h3>
      <p>{detail}</p>
      <p>
        <small>
          {recovery} · {error.code}
          {error.requestId === undefined ? null : ` · request ${error.requestId}`}
        </small>
      </p>
    </section>
  )
}

export const TracesPage = () => {
  const me = useQuery(meQuery)
  const traces = useQuery({ ...tracesQuery, enabled: me.data != null })

  if (me.isPending) return <p>Loading…</p>
  if (me.error !== null) return <Failure error={me.error} />
  if (me.data === null) return <LoginPage />

  if (traces.isPending) return <p>Loading traces…</p>
  if (traces.error !== null) return <Failure error={traces.error} />
  if (traces.data.length === 0) {
    return <p>No traces yet. Run an evaluation against /v1 and reload.</p>
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Trace</th>
          <th>Panel</th>
          <th>Passed</th>
          <th>Score</th>
          <th>Threshold</th>
          <th>Complete</th>
          <th>Follow-up</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {traces.data.map((trace) => (
          <tr key={trace.id}>
            <td>{trace.id}</td>
            <td>{trace.panel_id}</td>
            <td>{trace.passed ? 'pass' : 'fail'}</td>
            <td>{trace.score.toFixed(2)}</td>
            <td>{trace.threshold.toFixed(2)}</td>
            {/* False means a scoring judge did not run, so the score above is real but
                partial — a distinction the panel decision alone cannot show. */}
            <td>{trace.complete ? 'yes' : 'partial'}</td>
            {/* Null until the P5 queue job has stamped it. Visible because "the async
                follow-up ran" is one of the things M0 is claiming works. */}
            <td>{trace.recorded_at ?? 'pending'}</td>
            <td>{trace.created_at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
