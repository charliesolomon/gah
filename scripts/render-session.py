#!/usr/bin/env python3
"""Render a GAH session JSONL stream as a readable conversation.

Reads session entries (one JSON object per line) on stdin — either a whole
file or a live `tail -F` — and prints user/assistant/tool traffic with long
payloads truncated. Used by scripts/watch-session.sh.
"""

import json
import sys

TRUNC = {
    "user": 4000,
    "text": 8000,
    "thinking": 400,
    "args": 500,
    "result": 900,
}


def clip(s, n):
    s = s if isinstance(s, str) else json.dumps(s)
    return s if len(s) <= n else s[:n] + f" …[+{len(s) - n} chars]"


def blocks(content):
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def render(e):
    t = e.get("type")
    if t == "_watching":
        return f"### watching {e.get('file')}"
    if t == "session":
        return f"### session {e.get('id')}  cwd={e.get('cwd')}  ({e.get('timestamp')})"
    if t == "model_change":
        return f"### model = {e.get('provider')}/{e.get('modelId')}"
    if t == "thinking_level_change":
        return f"### thinking = {e.get('thinkingLevel')}"
    if t != "message":
        return f"### {t}: {clip(e, 300)}"

    m = e.get("message", {})
    role = m.get("role")
    out = []
    if role == "user":
        for b in blocks(m.get("content")):
            if b.get("type") == "text":
                out.append(f"\n>>> USER:\n{clip(b['text'], TRUNC['user'])}")
            else:
                out.append(f"\n>>> USER [{b.get('type')}]: {clip(b, 300)}")
    elif role == "assistant":
        for b in blocks(m.get("content")):
            bt = b.get("type")
            if bt == "text":
                out.append(f"\n<<< ASSISTANT:\n{clip(b['text'], TRUNC['text'])}")
            elif bt == "thinking":
                out.append(f"\n<<< [thinking] {clip(b.get('thinking', ''), TRUNC['thinking'])}")
            elif bt == "toolCall":
                out.append(
                    f"\n<<< TOOL CALL {b.get('name')}({clip(b.get('arguments', {}), TRUNC['args'])})"
                )
            else:
                out.append(f"\n<<< [{bt}] {clip(b, 300)}")
        stop = m.get("stopReason")
        if stop and stop not in ("stop", "toolUse", "end_turn"):
            out.append(f"    [stopReason: {stop}]")
        err = m.get("errorMessage") or m.get("error")
        if err:
            out.append(f"    [ERROR: {clip(err, 600)}]")
    elif role == "toolResult":
        body = " ".join(
            clip(b.get("text", b), TRUNC["result"]) for b in blocks(m.get("content"))
        )
        flag = " !ERROR" if m.get("isError") else ""
        out.append(f"    -> RESULT {m.get('toolName')}{flag}: {body}")
    else:
        out.append(f"### message[{role}]: {clip(m, 300)}")
    return "\n".join(out)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            print(f"### unparseable: {clip(line, 200)}", flush=True)
            continue
        print(render(e), flush=True)


if __name__ == "__main__":
    main()
