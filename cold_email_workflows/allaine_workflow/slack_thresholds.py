"""
Threshold-based Slack notifier for Allaine workflow.
Fires only when current Allaine-tagged lead count crosses a threshold upward.
Does NOT fire on downward crossings or when count stays above a threshold.
"""
import os
import json
import logging
import requests

log = logging.getLogger(__name__)

THRESHOLDS = [20, 35, 50, 75, 100]
STATE_FILE = os.path.join(os.path.dirname(__file__), 'slack_threshold_state.json')

SLACK_TOKEN   = os.getenv('SLACK_BOT_TOKEN')
SLACK_CHANNEL = os.getenv('SLACK_CHANNEL_ID', 'C0ARFBBN3TN')


def _load_state():
    if not os.path.exists(STATE_FILE):
        return {'last_notified_threshold': 0}
    try:
        with open(STATE_FILE) as f: return json.load(f)
    except Exception:
        return {'last_notified_threshold': 0}


def _save_state(s):
    with open(STATE_FILE, 'w') as f:
        json.dump(s, f)


def _threshold_crossed(count, last_notified):
    """
    Return the HIGHEST threshold that `count` meets or exceeds AND is strictly
    greater than `last_notified`. If none, return None.
    """
    candidates = [t for t in THRESHOLDS if count >= t and t > last_notified]
    return max(candidates) if candidates else None


def _send(current_count, threshold, added, removed_replied, removed_ni, removed_lto, run_dt_ist):
    if not SLACK_TOKEN:
        log.warning("SLACK_BOT_TOKEN not set — skipping Slack notification")
        return False
    removed_total = removed_replied + removed_ni + removed_lto
    time_str = run_dt_ist.strftime('%d %b %Y, %I:%M %p IST')

    blocks = [
        {"type": "header", "text": {"type": "plain_text",
            "text": f"🚨 Reply Queue crossed {threshold}+"}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*Triggered at*\n{time_str}"},
            {"type": "mrkdwn", "text": f"*Awaiting Response*\n{current_count}"},
        ]},
        {"type": "section", "fields": [
            {"type": "mrkdwn",
                "text": (f"*Leads Removed This Run*\n• Total: {removed_total}\n"
                         f"• Replied: {removed_replied}\n"
                         f"• Marked Not Interested: {removed_ni}\n• LTO: {removed_lto}")},
            {"type": "mrkdwn", "text": f"*Leads Added This Run*\n{added}"},
        ]},
    ]
    try:
        r = requests.post("https://slack.com/api/chat.postMessage",
                          headers={"Authorization": f"Bearer {SLACK_TOKEN}",
                                   "Content-Type": "application/json"},
                          json={"channel": SLACK_CHANNEL, "blocks": blocks, "unfurl_links": False},
                          timeout=15)
        if r.json().get('ok'):
            log.info(f"Slack notification sent for threshold {threshold}+")
            return True
        log.warning(f"Slack API error: {r.json().get('error')}")
    except Exception as e:
        log.warning(f"Slack send failed: {e}")
    return False


def maybe_notify(current_count, added, removed_replied, removed_ni, removed_lto, run_dt_ist):
    """
    Check thresholds and fire Slack message only on upward crossings.
    Updates state file if notification fired.
    Returns True if notification sent.
    """
    state = _load_state()
    last  = state.get('last_notified_threshold', 0)

    # If count drops back below the last notified threshold, reset state so the
    # next upward crossing fires again.
    if last > 0 and current_count < last:
        new_last = 0
        for t in THRESHOLDS:
            if current_count >= t: new_last = t
        if new_last != last:
            state['last_notified_threshold'] = new_last
            _save_state(state)
            log.info(f"  Slack state reset: last={last} → {new_last} (count dropped)")
            last = new_last

    crossed = _threshold_crossed(current_count, last)
    if crossed is None:
        log.info(f"  Slack: no threshold crossed (count={current_count}, last_notified={last})")
        return False

    sent = _send(current_count, crossed, added, removed_replied, removed_ni, removed_lto, run_dt_ist)
    if sent:
        state['last_notified_threshold'] = crossed
        _save_state(state)
    return sent
