/*
 * The online D-pad for arming and disarming.
 *
 * The code goes to the server and on to the box, which checks it. Nothing here
 * knows the code, and the entered moves are forgotten when the dialog closes.
 */

const MOVE_COUNT = 4;
const KEY_MOVES = { ArrowUp: "U", ArrowDown: "D", ArrowLeft: "L", ArrowRight: "R" };
const CLOSE_AFTER_MS = 1200;

const $ = (selector) => document.querySelector(selector);

function fmtWait(ms) {
  const minutes = Math.ceil(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

export function createArmPad() {
  const dialog = $("#arm-dialog");
  const toggle = $("#arm-toggle");
  const ok = $("#arm-ok");
  const clear = $("#arm-clear");
  const message = $("#arm-message");
  const dotsBox = $("#arm-dots");
  const dots = [...dotsBox.children];
  const moveKeys = [...dialog.querySelectorAll("[data-move]")];

  let armed = null;
  let live = false;
  let target = "disarm";
  let moves = [];
  let sending = false;
  let lockedUntil = 0;
  let lockTimer = null;
  let closeTimer = null;

  const isLocked = () => lockedUntil > Date.now();
  const isOff = (button) => button.getAttribute("aria-disabled") === "true";

  function paint() {
    const blocked = sending || isLocked() || !live;
    dots.forEach((dot, i) => dot.toggleAttribute("data-on", i < moves.length));
    dotsBox.setAttribute("aria-label", `${moves.length} of ${MOVE_COUNT} moves entered`);
    for (const key of moveKeys) key.setAttribute("aria-disabled", String(blocked || moves.length >= MOVE_COUNT));
    ok.setAttribute("aria-disabled", String(blocked || moves.length !== MOVE_COUNT));
    clear.setAttribute("aria-disabled", String(sending || moves.length === 0));
  }

  function say(text, tone = "") {
    message.textContent = text;
    message.dataset.tone = tone;
  }

  const prompt = () => say("Enter the arm code, the same one as the joystick.");

  function showLocked() {
    say(`Too many wrong codes. Try again in ${fmtWait(lockedUntil - Date.now())}.`, "negative");
  }

  function applyStatus({ lockedForMs, attemptsLeft }) {
    clearInterval(lockTimer);
    if (lockedForMs > 0) {
      lockedUntil = Date.now() + lockedForMs;
      showLocked();
      /* Keep the wait current, and reopen the pad when it ends. */
      lockTimer = setInterval(() => {
        if (isLocked()) {
          showLocked();
          return;
        }
        clearInterval(lockTimer);
        prompt();
        paint();
      }, 15_000);
    } else {
      lockedUntil = 0;
      return attemptsLeft;
    }
    return null;
  }

  function showOutcome(result) {
    const attemptsLeft = applyStatus(result);
    switch (result.outcome) {
      case "applied":
        sending = true; // nothing more to enter; the dialog is about to close
        say(target === "arm" ? "Alarm armed." : "Alarm disarmed.", "positive");
        closeTimer = setTimeout(() => dialog.close(), CLOSE_AFTER_MS);
        break;
      case "wrong":
        if (!isLocked()) say(`Wrong code. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left.`, "negative");
        break;
      case "locked":
        break; // applyStatus already said so
      case "busy":
        say("Another request is in progress. Try again in a moment.", "warning");
        break;
      case "offline":
        say("Couldn't reach the box, so nothing changed.", "warning");
        break;
      case "rejected":
        say("The box refused the request, so nothing changed.", "warning");
        break;
      default:
        say("No confirmation from the box. Check its status before trying again.", "warning");
    }
  }

  async function submit() {
    const code = moves.join("");
    moves = [];
    sending = true;
    say("Checking with the box…");
    paint();

    let result;
    try {
      const response = await fetch("api/arm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, target }),
      });
      result = await response.json();
    } catch {
      result = { outcome: "unknown" };
    }

    if (!dialog.open) {
      sending = false;
      return;
    }
    sending = false;
    showOutcome(result);
    paint();
  }

  function addMove(move) {
    if (sending || isLocked() || !live || moves.length >= MOVE_COUNT) return;
    moves.push(move);
    paint();
  }

  async function open() {
    if (isOff(toggle) || dialog.open) return;
    clearTimeout(closeTimer);
    target = armed === false ? "arm" : "disarm";
    moves = [];
    sending = false;
    lockedUntil = 0;
    $("#arm-title").textContent = target === "arm" ? "Arm the alarm" : "Disarm the alarm";
    prompt();
    paint();
    dialog.showModal();
    ok.focus();

    try {
      const attemptsLeft = applyStatus(await (await fetch("api/arm")).json());
      if (attemptsLeft !== null && attemptsLeft < 5 && !sending && moves.length === 0) {
        say(`${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left before the pad locks.`, "warning");
      }
      paint();
    } catch {
      /* The server still enforces the lockout when a code is sent. */
    }
  }

  toggle.addEventListener("click", open);

  dialog.addEventListener("click", (event) => {
    const key = event.target.closest("[data-move]");
    if (key && !isOff(key)) addMove(key.dataset.move);
  });

  ok.addEventListener("click", () => {
    if (!isOff(ok)) submit();
  });

  clear.addEventListener("click", () => {
    if (isOff(clear)) return;
    moves = [];
    paint();
  });

  dialog.addEventListener("keydown", (event) => {
    if (KEY_MOVES[event.key]) {
      event.preventDefault();
      if (!event.repeat) addMove(KEY_MOVES[event.key]);
    } else if (event.key === "Backspace" && !sending) {
      event.preventDefault();
      moves.pop();
      paint();
    }
  });

  dialog.addEventListener("close", () => {
    moves = [];
    clearInterval(lockTimer);
    clearTimeout(closeTimer);
  });

  return {
    update(next) {
      armed = next.armed;
      live = next.live;
      const known = live && armed !== null;
      const label = armed === false ? "Arm" : "Disarm";
      if (toggle.textContent !== label) toggle.textContent = label;
      toggle.setAttribute("aria-disabled", String(!known));
      toggle.title = known ? "" : "The box isn't reporting its alarm state";
      if (dialog.open) paint();
    },
  };
}
