#!/usr/bin/env python3
"""
The Vic 361 — Approval Reply Watcher

Polls Gmail via IMAP for replies to the most recent weekly digest. When a
reply is found, parses the picks string and prints the result to stdout in
a stable format the GitHub Action can act on.

Output format (stdout, exactly one of):
    PICKS=<value>         when a reply was parsed (e.g. PICKS=ALL or PICKS=1,3,5,8)
    NO_REPLY              no reply found yet
    NO_DIGEST             no digest email exists for this week (collector hasn't run yet)
    ERROR=<msg>           IMAP/parse error

The script also writes a status line to stderr for debugging.

Required env:
    SMTP_EMAIL      \u2014 also used as the IMAP account
    SMTP_PASSWORD   \u2014 the same Gmail App Password used for sending
    IMAP_HOST       \u2014 default imap.gmail.com
    IMAP_PORT       \u2014 default 993
"""

import email
import email.message
import imaplib
import os
import re
import sys
from datetime import datetime, timedelta
from email.header import decode_header
from email.utils import parsedate_to_datetime


DIGEST_TOKEN_RE = re.compile(r"\[VIC361-DIGEST\s+(\d{4}-\d{2}-\d{2})\]")


def log(msg: str) -> None:
    print(f"[watcher] {msg}", file=sys.stderr)


def emit(line: str) -> None:
    """Emit a single result line to stdout and exit cleanly."""
    print(line)
    sys.exit(0)


def decode_subject(raw: str) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    out = []
    for chunk, enc in parts:
        if isinstance(chunk, bytes):
            try:
                out.append(chunk.decode(enc or "utf-8", errors="replace"))
            except LookupError:
                out.append(chunk.decode("utf-8", errors="replace"))
        else:
            out.append(chunk)
    return "".join(out)


def get_body_text(msg: email.message.Message) -> str:
    """Extract the plain-text body. Falls back to stripping HTML if needed."""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "").lower()
            if ctype == "text/plain" and "attachment" not in disp:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                try:
                    return payload.decode(charset, errors="replace")
                except LookupError:
                    return payload.decode("utf-8", errors="replace")
        # Fallback: first text/html
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                try:
                    html = payload.decode(charset, errors="replace")
                except LookupError:
                    html = payload.decode("utf-8", errors="replace")
                return re.sub(r"<[^>]+>", " ", html)
    else:
        payload = msg.get_payload(decode=True) or b""
        charset = msg.get_content_charset() or "utf-8"
        try:
            return payload.decode(charset, errors="replace")
        except LookupError:
            return payload.decode("utf-8", errors="replace")
    return ""


def strip_quoted(body: str) -> str:
    """Trim Gmail-style quoted reply blocks so we only see what the user wrote."""
    # Common reply markers
    patterns = [
        r"\nOn .* wrote:\s*\n",          # Gmail "On Sun, Apr 26, 2026 at 8:00 AM ... wrote:"
        r"\n>+",                          # Plain-text quoting
        r"\n-{2,}\s*Original Message",   # Outlook
        r"\nFrom: ",                     # Outlook style
        r"\nSent from my ",              # Mobile signatures
    ]
    cut = len(body)
    for p in patterns:
        m = re.search(p, body)
        if m and m.start() < cut:
            cut = m.start()
    return body[:cut].strip()


def parse_picks(text: str):
    """Convert a free-form reply into a normalized picks string.

    Returns:
        ("ALL", None)                    \u2014 keep everything
        ("NONE", None)                   \u2014 publish nothing
        ("LIST", "1,3,5,8")              \u2014 specific numbers
        ("EXCEPT", "1-50 except 7,12")   \u2014 ALL minus exclusions (handled in approve_events)
        ("UNPARSEABLE", None)
    """
    if not text:
        return ("UNPARSEABLE", None)

    t = text.strip()
    # Take just the first 500 chars \u2014 reply bodies can have huge signatures we
    # already tried to strip, but be defensive.
    t = t[:500]
    upper = t.upper()

    # Catch "NONE" / "SKIP" / "PUBLISH NOTHING"
    if re.search(r"\b(NONE|NOTHING|SKIP\s+ALL)\b", upper) and "EXCEPT" not in upper:
        return ("NONE", None)

    # Catch "ALL except X, Y" before bare "ALL"
    m = re.search(r"\bALL\b[^\d]*EXCEPT[^\d]*([\d,\s\-]+)", upper)
    if m:
        excl = _normalize_number_list(m.group(1))
        if excl:
            return ("EXCEPT", excl)

    # Bare ALL (and nothing that looks like a number list afterwards)
    if re.search(r"\bALL\b", upper):
        # If they wrote "ALL of 1,2,3" or similar, treat as LIST instead
        nums_after = re.search(r"\bALL\b[^\d]*([\d][\d,\s\-]*)", upper)
        if nums_after:
            normalized = _normalize_number_list(nums_after.group(1))
            if normalized:
                # If it's a contiguous-ish list, treat as the explicit list.
                # But if "ALL" stood alone first \u2014 prefer ALL.
                pre = upper[: nums_after.start()].strip()
                if pre.endswith("ALL"):
                    return ("ALL", None)
                return ("LIST", normalized)
        return ("ALL", None)

    # Just numbers / ranges
    normalized = _normalize_number_list(t)
    if normalized:
        return ("LIST", normalized)

    return ("UNPARSEABLE", None)


def _normalize_number_list(raw: str) -> str:
    """Take a free-text number list and emit a clean comma-separated string.

    Accepts: '1, 3, 5-8', '1 3 5', '[1] [3] [5]', '1.3.5'
    Rejects: anything with no digits.
    """
    if not raw:
        return ""
    # Pull out tokens that look like '1' or '1-5'
    tokens = re.findall(r"\d+\s*-\s*\d+|\d+", raw)
    if not tokens:
        return ""
    cleaned = []
    for tok in tokens:
        tok = re.sub(r"\s+", "", tok)
        cleaned.append(tok)
    return ",".join(cleaned)


def find_digest_for_today(imap, mailbox="INBOX"):
    """Find the most recent digest sent in the last 7 days.

    Returns (digest_uid, digest_date, digest_message_id, digest_subject) or None.
    """
    imap.select(mailbox, readonly=True)
    since = (datetime.now() - timedelta(days=8)).strftime("%d-%b-%Y")
    # Use the stable token for matching; quoting on Gmail IMAP is finicky so we
    # search broadly and filter by regex client-side.
    typ, data = imap.uid("SEARCH", None, f'(SINCE {since} SUBJECT "VIC361-DIGEST")')
    if typ != "OK":
        return None
    uids = data[0].split()
    if not uids:
        return None
    # Walk newest-first
    for uid in reversed(uids):
        typ, msg_data = imap.uid("FETCH", uid, "(BODY.PEEK[HEADER])")
        if typ != "OK":
            continue
        raw = b""
        for part in msg_data:
            if isinstance(part, tuple) and len(part) >= 2:
                raw = part[1]
                break
        msg = email.message_from_bytes(raw)
        subj = decode_subject(msg.get("Subject") or "")
        m = DIGEST_TOKEN_RE.search(subj)
        if not m:
            continue
        digest_date = m.group(1)
        message_id = (msg.get("Message-Id") or msg.get("Message-ID") or "").strip()
        return (uid, digest_date, message_id, subj)
    return None


def find_reply(imap, digest_subject: str, digest_message_id: str, digest_date: str):
    """Find the most recent reply that came AFTER the digest.

    Strategy:
      1. Search for messages that include the digest's Message-ID in their
         References / In-Reply-To headers (the proper way \u2014 RFC threading).
      2. Fallback: subject contains 'VIC361-DIGEST <date>' AND From contains
         our own address (since you reply to yourself).
    """
    imap.select("INBOX", readonly=True)
    # Strategy 1 \u2014 threading headers
    if digest_message_id:
        # Strip surrounding angle brackets for IMAP search
        bare_id = digest_message_id.strip("<>").strip()
        if bare_id:
            typ, data = imap.uid(
                "SEARCH", None,
                f'(OR HEADER "In-Reply-To" "{bare_id}" HEADER "References" "{bare_id}")'
            )
            if typ == "OK" and data and data[0]:
                uids = data[0].split()
                if uids:
                    return _fetch_latest_body(imap, uids)

    # Strategy 2 \u2014 subject token + sender
    smtp_email = os.environ.get("SMTP_EMAIL", "")
    typ, data = imap.uid(
        "SEARCH", None,
        f'(SUBJECT "VIC361-DIGEST {digest_date}" FROM "{smtp_email}")'
    )
    if typ != "OK" or not data or not data[0]:
        return None
    uids = data[0].split()
    # Skip the original digest itself \u2014 only consider messages whose subject
    # starts with "Re:" (replies)
    reply_uids = []
    for uid in uids:
        typ, msg_data = imap.uid("FETCH", uid, "(BODY.PEEK[HEADER])")
        if typ != "OK":
            continue
        raw = b""
        for part in msg_data:
            if isinstance(part, tuple) and len(part) >= 2:
                raw = part[1]
                break
        msg = email.message_from_bytes(raw)
        subj = decode_subject(msg.get("Subject") or "")
        if subj.lower().lstrip().startswith("re:"):
            reply_uids.append(uid)
    if not reply_uids:
        return None
    return _fetch_latest_body(imap, reply_uids)


def _fetch_latest_body(imap, uids):
    """Fetch the most recent message from a list of UIDs, return its plain body."""
    # UIDs are returned in ascending order
    latest_uid = uids[-1]
    typ, msg_data = imap.uid("FETCH", latest_uid, "(BODY.PEEK[])")
    if typ != "OK":
        return None
    raw = b""
    for part in msg_data:
        if isinstance(part, tuple) and len(part) >= 2:
            raw = part[1]
            break
    if not raw:
        return None
    msg = email.message_from_bytes(raw)
    body = get_body_text(msg)
    body = strip_quoted(body)
    return {
        "uid": latest_uid.decode() if isinstance(latest_uid, bytes) else latest_uid,
        "body": body,
        "subject": decode_subject(msg.get("Subject") or ""),
        "from": msg.get("From"),
        "date": msg.get("Date"),
    }


def main():
    smtp_email = os.environ.get("SMTP_EMAIL")
    smtp_password = os.environ.get("SMTP_PASSWORD")
    imap_host = os.environ.get("IMAP_HOST", "imap.gmail.com")
    imap_port = int(os.environ.get("IMAP_PORT", "993"))

    if not smtp_email or not smtp_password:
        emit("ERROR=Missing SMTP_EMAIL or SMTP_PASSWORD")

    try:
        imap = imaplib.IMAP4_SSL(imap_host, imap_port)
        imap.login(smtp_email, smtp_password)
    except Exception as e:
        emit(f"ERROR=IMAP login failed: {e}")

    try:
        digest = find_digest_for_today(imap)
        if not digest:
            log("No VIC361-DIGEST email found in the last 8 days.")
            emit("NO_DIGEST")
        digest_uid, digest_date, digest_message_id, digest_subject = digest
        log(f"Found digest: date={digest_date} subject={digest_subject!r}")

        reply = find_reply(imap, digest_subject, digest_message_id, digest_date)
        if not reply:
            log("No reply yet.")
            emit("NO_REPLY")

        log(f"Reply found, body length={len(reply['body'])}")
        log(f"Reply preview: {reply['body'][:200]!r}")

        kind, value = parse_picks(reply["body"])
        log(f"Parse result: kind={kind} value={value!r}")

        if kind == "ALL":
            emit("PICKS=ALL")
        elif kind == "NONE":
            emit("PICKS=NONE")
        elif kind == "LIST":
            emit(f"PICKS={value}")
        elif kind == "EXCEPT":
            emit(f"PICKS=EXCEPT:{value}")
        else:
            emit("ERROR=Unparseable reply")
    finally:
        try:
            imap.logout()
        except Exception:
            pass


if __name__ == "__main__":
    main()
