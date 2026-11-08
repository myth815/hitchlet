# Temporary shared-host compute consent

An administrator may set `humanUsePolicy.unmanagedComputeConsentUntilMs` through the existing machine human-use policy API. The value is an explicit deadline, must be in the future and no more than one hour from the policy write, and is absent by default. Use a deliberately small `attendedMaximum` for the approved task. Removing the field revokes the exception for new reservations; reaching its deadline does the same automatically.

The exception permits compute only when the authenticated Host observation is fresh, complete and not revoked, no human session or interaction is present, `unmanagedActivityHold` is **true**, resource pressure facts are available and below the existing limits, and `admissionDuringInteraction` is `within_reserved_budget`. An unknown/null hold, partial observation, static manual inventory, exclusive maintenance, resource exhaustion or normal Node/claim checks are not bypassed. The attended ceiling applies even though the human presence sample is absent.

The observed hold remains true in all views. This consent does not assert that external work is idle and never permits shutdown. Existing power preparation/commit, human protection and unknown-work guards continue to operate. Existing Tickets are not force-stopped when consent expires.

Preview and reservation evaluate the policy separately. The reservation transaction additionally checks the real SQLite clock against the earliest of the consent deadline and the Host sample/receipt freshness deadlines, in addition to the existing immutable-input CAS fence. A preview, queued request or prepared reservation cannot carry the exception across those deadlines.

Use the normal administrator policy dry-run and CAS update; do not edit the ledger, alter a Host observation or grant a consumer unrestricted management credentials. Save the original policy, use the existing consumer's authorization/quota and normal Ticket lifecycle, then restore the original policy after the bounded task. This is distinct from a collaborator usage Hold, which protects power until explicitly released.
