# Quick capture

Send text to HushJot from another app and it becomes a new note, encrypted like
every other one. Nothing you share leaves your device in the clear.

There is nothing to set up on Android. iOS needs a Shortcut, which you build
once.

---

## Android

Install HushJot to your home screen. From then on it appears in the share sheet
of every app: tap **Share**, pick **HushJot**, and the note opens ready to edit.

What you shared arrives as one note — the app's title as a heading, the text
below it, and the link on its own line if there was one. A capture is written
straight away rather than asking first, so quick capture stays one tap; the
banner that appears offers **Undo**, and an undone note goes to Recently
deleted rather than disappearing.

If the vault is locked when the share arrives, HushJot asks for your passphrase
first and writes the note once you are in.

**If you installed HushJot before this feature existed**, accept the update
prompt the next time you open it. Your browser re-reads the app's details on its
own schedule, so the share sheet can take a launch or two to catch up.
Reinstalling is the quick way.

---

## iPhone and iPad

Safari does not offer its share sheet to a web app, at any price. The way in is
a Shortcut:

1. Open **Shortcuts** and tap **+**.
2. Tap the **ⓘ** button, turn on **Show in Share Sheet**, and set the accepted
   input to **Text** only.
3. Add the **URL Encode** action, set to encode **Shortcut Input**.
4. Add a **Text** action containing `https://hushjot.com/#c1.` followed by the
   encoded result. (Use your own address if you host HushJot yourself — the
   Quick capture panel inside the app, under **Account**, shows the exact prefix
   for the site you are on, with a Copy button.)
5. Add the **Open URLs** action and give it that text.
6. Name it something like **Add to HushJot** and save.

Now select text anywhere, tap **Share**, and choose your shortcut.

### Two things to know

**The text travels in the part of the address after the `#`.** Browsers never
send that to a server, which is why it is there rather than in a query string.
HushJot clears it from the address bar as soon as the note exists.

**The shortcut opens your default browser, not the home screen app.** Since
iOS 16.4 a home screen web app keeps storage separate from Safari, so the
capture lands in the Safari copy of HushJot — which may ask for your passphrase
even though the home screen app is unlocked. If you sync with an account the
note reaches your other devices from either one. If you use HushJot locally on
one device only, keep it in Safari rather than on the home screen, or expect to
unlock twice.

---

## What is not supported

Sharing **files** — a `.md` or `.txt` from a file manager — does nothing;
HushJot only accepts text. Use **Import** in the Export or import dialog for
files, including exports from Simplenote and Google Keep.
