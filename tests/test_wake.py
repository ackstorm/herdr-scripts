import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


WAKE = Path(__file__).resolve().parents[1] / "skills/wake/scripts/wake.sh"
START = 2_000_000_000
PROMPT = "It's time.\nSay hello to $USER."


class WakeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.jobs = self.root / "jobs"
        self.clock = self.root / "clock"
        self.log = self.root / "events"
        self.log.touch()
        self.advance(0)
        self.env = dict(
            os.environ,
            WAKE_DIR=str(self.jobs),
            PATH=f"{self.root}:{os.environ['PATH']}",
            HC_TERMINAL_ID="t1",
            CODEX_HOME=str(self.root),
            CODEX_THREAD_ID="sample-thread",
            TEST_DIR=str(self.root),
        )
        self.stub("date", """
if [ "$*" = '+%s' ]; then cat "$TEST_DIR/clock"; else exec /bin/date "$@"; fi
""")
        self.stub("sleep", "exec /bin/sleep 0.025")
        self.stub("hc", """
case "$1" in
  ls) echo '{"terminals":[{"address":"t1"}]}' ;;
  get) if [ -f "$TEST_DIR/background" ]; then CLIENT_PID=0; fi
       printf '{"foreground":{"name":"%s","pid":%d,"argv":[]}}\n' "$CLIENT" "$CLIENT_PID" ;;
  read) echo 'sample-marker' ;;
  keys|kill|send|run)
    jq -cn --args '$ARGS.positional' -- "$@" >>"$TEST_DIR/events"
    if [ "$1" = send ] && [ -p "$TEST_DIR/draft" ]; then read -r reply <"$TEST_DIR/draft"; fi
    if [ "$1" = keys ] || [ "$1" = kill ]; then kill "$CLIENT_PID"; fi ;;
  *) exit 2 ;;
esac
""")

    def stub(self, name, body):
        path = self.root / name
        path.write_text("#!/bin/sh\nset -eu\n" + body + "\n")
        path.chmod(0o755)

    def advance(self, seconds):
        new = self.clock.with_suffix(".tmp")
        new.write_text(str(START + seconds))
        new.replace(self.clock)

    def wake(self, *args):
        return subprocess.run(
            [WAKE, *args], env=self.env, cwd=self.root, text=True,
            capture_output=True, check=True, timeout=5,
        ).stdout

    def events(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def wait_for(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f"Timed out waiting for Wake. Events: {self.events()}")
            time.sleep(0.025)

    def start_client(self, name):
        binary = self.root / name
        if not binary.exists():
            binary.symlink_to("/bin/sleep")
        proc = subprocess.Popen([binary, "30"])

        def stop():
            if proc.poll() is None:
                proc.terminate()
            proc.wait(timeout=2)
        self.addCleanup(stop)
        self.env.update(CLIENT=name, CLIENT_PID=str(proc.pid))
        return proc

    def schedule(self, name, delay):
        due = f"@{START + delay}"
        if name == "codex":
            return self.wake("resume", due, PROMPT, "sample-marker")
        return self.wake("resume-agent", due, PROMPT, f"{name} resume sample-thread")

    def test_close_then_resume_once(self):
        for agent, close in (("codex", "keys"), ("opencode", "kill"), ("claude", None)):
            with self.subTest(agent=agent):
                self.advance(0)
                self.log.write_text("")
                client = self.start_client(agent)
                reply = self.schedule(agent, 90)
                self.assertIn("one minute", reply)
                self.assertIn("wake.sh rm", reply)
                self.wake("rearm")
                self.advance(59)
                time.sleep(0.15)
                self.assertIsNone(client.poll())
                self.assertEqual(self.events(), [])
                self.advance(60)
                client.wait(timeout=3)
                closed = [event[0] for event in self.events()]
                self.assertEqual(closed, [close] if close else [])
                self.advance(90)
                self.wait_for(lambda: not list(self.jobs.glob("wake-*")))
                events = self.events()
                self.assertEqual([event[0] for event in events], closed + ["run"])
                self.assertIn("sample-thread", events[-1][-1])

    def test_short_wake_sends_prompt_to_open_client(self):
        client = self.start_client("opencode")
        self.assertIn("keep this session open", self.schedule("opencode", 59))
        self.advance(59)
        self.wait_for(lambda: not list(self.jobs.glob("wake-*")))
        self.assertEqual(self.events(), [["send", "t1", "--", PROMPT]])
        self.assertIsNone(client.poll())

    def test_cancel_removes_close_and_resume(self):
        client = self.start_client("codex")
        self.schedule("codex", 120)
        name, = self.jobs.glob("wake-*")
        self.advance(59)
        self.wake("rm", name.name)
        self.advance(120)
        time.sleep(0.15)
        self.assertFalse(name.exists())
        self.assertIsNone(client.poll())
        self.assertEqual(self.events(), [])

    def test_close_retried_at_due_time(self):
        client = self.start_client("opencode")
        self.schedule("opencode", 90)
        background = self.root / "background"
        background.touch()
        self.advance(60)
        time.sleep(0.15)
        self.assertEqual(self.events(), [])
        self.assertIsNone(client.poll())
        background.unlink()
        self.advance(90)
        client.wait(timeout=3)
        self.wait_for(lambda: not list(self.jobs.glob("wake-*")))
        self.assertEqual([e[0] for e in self.events()], ["kill", "run"])

    def test_pending_delivery_allows_cancelling_another_job(self):
        self.start_client("opencode")
        self.schedule("opencode", 120)
        long_job, = self.jobs.glob("wake-*")
        fifo = self.root / "draft"
        os.mkfifo(fifo)
        self.schedule("opencode", 20)
        self.advance(20)
        self.wait_for(lambda: bool(self.events()))
        try:
            self.wake("rm", long_job.name)
        finally:
            with fifo.open("w") as draft:
                draft.write("ready\n")
        self.wait_for(lambda: not list(self.jobs.glob("wake-*")))

    def test_standalone_short_wake_returns_prompt_to_caller(self):
        client = self.start_client("claude")
        del self.env["HC_TERMINAL_ID"]
        with subprocess.Popen(
            [WAKE, "resume-agent", f"@{START + 10}", PROMPT, "claude --resume example", str(client.pid)],
            cwd=self.root, env=self.env, text=True, stdout=subprocess.PIPE,
        ) as timer:
            self.wait_for(lambda: bool(list(self.jobs.glob("wake-*"))))
            self.advance(10)
            output, _ = timer.communicate(timeout=3)
        self.assertEqual(timer.returncode, 0)
        self.assertIn("keep this session open", output)
        self.assertTrue(output.endswith(PROMPT + "\n"))
        self.assertIsNone(client.poll())
        self.assertEqual(self.events(), [])

    def test_rearm_runs_existing_command_job(self):
        self.jobs.mkdir()
        job = self.jobs / "wake-0518-0333"
        job.write_text(f"{START}\n{self.root}\n\nprintf hello\n")
        self.wake("rearm")
        self.wait_for(lambda: not job.exists())
        event, = self.events()
        self.assertEqual(event[0], "run")
        self.assertEqual(event[-1], "printf hello")


if __name__ == "__main__":
    unittest.main()
