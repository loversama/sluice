/**
 * One line for the tray, per idle reason.
 *
 * A copy of the dashboard's wording rather than an import: the main process cannot reach
 * into web/, and duplicating four short strings is cheaper than a shared build step for
 * them. The dashboard's version is the one under test; keep them saying the same thing.
 */
export function idleTooltip(idle: { reason?: string } | null): string {
    switch (idle?.reason) {
        case "all_claimed":
            return "All drops claimed - watching for new campaigns";
        case "nothing_eligible":
            return "Nothing matches your settings - watching for new campaigns";
        case "no_campaigns":
            return "No campaigns running - watching for new ones";
        case "no_live_channels":
            return "Waiting for someone to go live";
        default:
            return "Sluice";
    }
}
