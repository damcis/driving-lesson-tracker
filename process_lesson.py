"""
process_lesson.py
------------------
Reads the lesson summary + skills data that the Driving Lesson Tracker
app copies to your clipboard, logs into the TDS staff portal, finds the
matching student in "Needs Attention", processes the lesson, fills in
the In-Car Lesson evaluation, and pastes your notes.

It stops right before "Complete Lesson (Send Email)" so you can glance
over the form and click that yourself - this version never sends the
email automatically.

SETUP (one time)
-----------------
1. py -m pip install playwright python-dotenv pyperclip
   py -m playwright install chromium

2. Fill in TDSM_USERNAME and TDSM_PASSWORD in the .env file that sits
   next to this script. Never paste .env into a chat.

3. In the tracker app, tap "Copy Summary" for the student you just
   finished, then run:  py process_lesson.py

IF IT STOPS PARTWAY
--------------------
It prints which step it was on and saves debug_failure.png in the folder
you ran it from. Send me the printed message plus that screenshot.
(The screenshot shows student names - crop it if you'd rather.)
"""

import asyncio
import json
import os
import re
import sys

import pyperclip
from dotenv import load_dotenv
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

load_dotenv()

LOGIN_URL = os.environ["TDSM_LOGIN_URL"]
USERNAME = os.environ["TDSM_USERNAME"]
PASSWORD = os.environ["TDSM_PASSWORD"]

SLOW = 60_000  # ms - the portal is slow to finish loading pages

# The app's skill names -> the portal's wording, only where the spelling
# differs (capitalization and punctuation are ignored automatically).
SKILL_ALIASES = {
    "Accelerator Control": "Accelerater control",  # portal's own typo
    "Parallel Parking": "Parallell parking",        # portal's own typo
}

# Skills on the Did Not Cover / Needs Improvement / Met Standards scale.
STANDARD_SKILLS = [
    "Car Familiarity", "Hand Position", "Steering", "Braking Control",
    "Braking Distance", "Accelerator Control", "Speed Control",
    "Speed During Turns", "Use of Turn Signals", "Use of Mirrors - General",
    "Shoulder Checks", "Blind Spots", "Lane Position", "Lane Changes",
    "Right & Left Turns", "Right & Left Turns in Double Lanes",
    "Approach a Corner", "Intersections", "Scanning Intersections",
    "Stop Signs", "Traffic Lights (Arrows)", "4-Way Stops", "Right on Red",
    "Right of Way", "Following Distance", "Stopping Distance", "Passing",
    "Merging", "Freeways", "Traffic Circles", "Curved Roads",
    "Backing in a Straight Line", "U-Turns", "3-Point Turn & 2-Point Turns",
    "Parallel Parking", "Perpendicular Parking", "Road Signs - Knowledge",
    "General Observation / Commentary Driving",
]

# Skills on the Needs work / Good / Excellent scale.
RATING_SKILLS = ["Attitude", "Comfort Level"]

# ---------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------
UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
LOW = UP.lower()
IGNORED = " \u00a0&/()-.,:'\u2019"  # characters skipped when comparing labels

STEP = ""


def step(msg: str):
    """Remember (and print) what we're doing, so a failure says where."""
    global STEP
    STEP = msg
    print(f"-> {msg}")


def normalize(s: str) -> str:
    """Lowercase and drop everything except letters/numbers."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def key(expr: str) -> str:
    """XPath: lowercase `expr` and drop spaces/punctuation, so
    'Braking control' and 'Braking Control' compare equal."""
    return f'translate({expr}, "{UP}{IGNORED}", "{LOW}")'


def exact_text(word: str):
    """Regex for an element whose whole text is `word`, any capitalization."""
    return re.compile(r"^\s*" + re.escape(word) + r"\s*$", re.I)


# An element that is an ACTION button: text starts with "action", short.
ACTION_COND = (
    f'starts-with(translate(normalize-space(.), "{UP}", "{LOW}"), "action") '
    "and string-length(normalize-space(.)) < 12"
)


def read_clipboard():
    clip = pyperclip.paste()
    marker = "###SKILLS_DATA###"
    if marker not in clip:
        sys.exit(
            "Clipboard doesn't look like it's from the tracker app "
            "(no ###SKILLS_DATA### block found). Copy the summary again."
        )
    essay, data_block = clip.split(marker, 1)
    data = json.loads(data_block.strip())
    return essay.strip(), data["studentName"], set(
        normalize(s) for s in data["needsPractice"]
    )


# ---------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------
async def login(page):
    step("Logging in")
    await page.goto(LOGIN_URL)
    await page.locator("input:visible").nth(0).fill(USERNAME)
    await page.locator('input[type="password"]').fill(PASSWORD)
    # no_wait_after: the dashboard is slow to fire its "load" event, and a
    # plain click() sits waiting for it - that was the 30 second timeout.
    await page.get_by_role("button", name=exact_text("login")).click(
        no_wait_after=True
    )
    try:
        await page.wait_for_url(re.compile("StaffHome", re.I), wait_until="commit")
    except PWTimeout:
        raise RuntimeError(
            "Login didn't move on to the dashboard - check TDSM_USERNAME "
            "and TDSM_PASSWORD in .env."
        )
    step("Waiting for the dashboard to show Needs Attention")
    await page.get_by_text(re.compile("needs attention", re.I)).filter(
        visible=True
    ).first.wait_for(state="visible")


async def open_process_menu(page, student_name: str):
    step(f"Finding '{student_name}' in Needs Attention")
    tokens = re.findall(r"[A-Za-z0-9'\u2019]+", student_name)
    if not tokens:
        raise RuntimeError(
            "No student name in the clipboard data - fill in Student Name "
            "in the app, then copy again."
        )
    # The portal lists "LAST, FIRST MIDDLE", so match every word you typed,
    # in any order and any capitalization.
    pattern = re.compile(
        "".join("(?=[\\s\\S]*" + re.escape(t) + ")" for t in tokens), re.I
    )
    matches = page.get_by_text(pattern).filter(visible=True)
    try:
        await matches.first.wait_for(state="visible", timeout=30_000)
    except PWTimeout:
        raise RuntimeError(
            f"No student in Needs Attention matched '{student_name}'. "
            "Check the Student Name in the app."
        )
    count = await matches.count()
    idx = 0
    if count > 1:
        print(f"{count} entries match '{student_name}':")
        for i in range(count):
            print(f"  {i + 1}) {(await matches.nth(i).inner_text()).strip()}")
        choice = await asyncio.to_thread(input, "Which one? Enter a number: ")
        idx = int(choice) - 1

    name_el = matches.nth(idx)
    # nearest enclosing block that contains an ACTION button = this card
    card = name_el.locator(f"xpath=ancestor::*[.//*[{ACTION_COND}]][1]")
    toggle = card.locator(f"xpath=.//*[{ACTION_COND}]").first

    step("Opening the Action menu")
    await toggle.click()

    step("Choosing Process from the Action menu")
    pat = exact_text("process")
    for scope in (card, page):
        item = scope.get_by_text(pat).filter(visible=True).first
        try:
            await item.wait_for(state="visible", timeout=5_000)
        except PWTimeout:
            continue
        await item.click(no_wait_after=True)
        return
    raise RuntimeError("Couldn't find 'Process' in the Action menu.")


async def press_process_button(page):
    step("Waiting for the lesson page")
    await page.get_by_text(re.compile("BTW Hours Enrolled", re.I)).first.wait_for(
        state="visible"
    )
    step("Pressing the PROCESS button")
    btn = page.get_by_text(exact_text("process")).filter(visible=True).first
    await btn.wait_for(state="visible")
    await btn.click(no_wait_after=True)


async def checklist_visible(page, timeout: int) -> bool:
    """True once the skills checklist (first row: Car Familiarity) is showing."""
    try:
        await page.locator(
            f'xpath=//*[{key(".")}="{normalize("Car Familiarity")}"]'
        ).first.wait_for(state="visible", timeout=timeout)
        return True
    except PWTimeout:
        return False


async def choose_evaluation(page):
    """Pick In-Car Lesson. Never fatal: if the dropdown can't be used (for
    example the page already has In-Car Lesson selected), carry on."""
    step("Choosing In-Car Lesson in the evaluation dropdown")
    try:
        # If the checklist is already showing, In-Car Lesson is already set.
        if await checklist_visible(page, 5_000):
            print("   In-Car Lesson already selected")
            return
        try:
            await page.get_by_text(exact_text("select evaluation")).filter(
                visible=True
            ).first.click(timeout=8_000)
            await page.get_by_text(exact_text("in-car lesson")).filter(
                visible=True
            ).first.click(timeout=8_000)
            return
        except PWTimeout:
            await page.keyboard.press("Escape")  # close a half-open list
        # Fallback: a plain <select> hidden behind a styled widget.
        opt = re.compile("in-car lesson", re.I)
        sel = page.locator("select").filter(
            has=page.locator("option", has_text=opt)
        )
        if await sel.count():
            value = await sel.first.locator("option", has_text=opt).first.get_attribute(
                "value", timeout=5_000
            )
            await sel.first.select_option(value=value, force=True, timeout=5_000)
            return
        print("   no evaluation dropdown to use - assuming it's already set")
    except Exception as e:
        print(f"   skipped the evaluation dropdown ({type(e).__name__}) - carrying on")


def skill_xpath(label: str, option: str) -> str:
    """The first `option` text that follows `label` in the page."""
    return (
        f'xpath=(//*[{key(".")}="{normalize(label)}"])[1]'
        f'/following::*[{key(".")}="{normalize(option)}"][1]'
    )


async def set_skills(page, needs_practice: set):
    step("Waiting for the evaluation checklist")
    if not await checklist_visible(page, SLOW):
        raise RuntimeError(
            "The skills checklist never appeared - In-Car Lesson may not have "
            "been selected. Pick it by hand and run again (see debug_failure.png)."
        )

    step("Setting the skills")
    done, missed = 0, []
    for name in STANDARD_SKILLS + RATING_SKILLS:
        if name in RATING_SKILLS:
            target = "Needs work" if normalize(name) in needs_practice else "Good"
        else:
            target = (
                "Needs Improvement"
                if normalize(name) in needs_practice
                else "Met Standards"
            )
        loc = page.locator(skill_xpath(SKILL_ALIASES.get(name, name), target))
        if await loc.count() == 0:
            missed.append(name)
            continue
        try:
            await loc.first.click(timeout=10_000)
            done += 1
        except PWTimeout:
            missed.append(name)
    print(f"   set {done} skills")
    if missed:
        print("   couldn't set (please do these by hand): " + ", ".join(missed))


async def paste_notes(page, essay: str):
    step("Pasting the lesson notes")
    await page.locator("textarea:visible").first.fill(essay)


async def main():
    essay, student_name, needs_practice = read_clipboard()
    print(f"Processing lesson for: {student_name}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()
        page.set_default_timeout(SLOW)
        try:
            await login(page)
            await open_process_menu(page, student_name)
            await press_process_button(page)
            await choose_evaluation(page)
            await set_skills(page, needs_practice)
            await paste_notes(page, essay)
            print("\nDone filling the form. Review it in the browser, then")
            print("click 'Complete Lesson (Send Email)' yourself when ready.")
        except Exception as e:
            print(f"\nStopped at: {STEP}\n{type(e).__name__}: {e}")
            try:
                await page.screenshot(path="debug_failure.png")
                print("Saved debug_failure.png in the folder you ran this from.")
            except Exception:
                pass
        await asyncio.to_thread(input, "\nPress Enter to close the browser...")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
