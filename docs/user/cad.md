# AutoCAD and SketchUp

Agents can read and edit the drawing or model you have open in AutoCAD or SketchUp. Ask for an overview of the drawing, what is selected, or objects by layer, type, or area; capture the current view as an image; or have the agent draw, move, rotate, recolor, or retag objects. Every agent you use in T3 Code gets these tools without any setup in the agent itself, along with a built-in CAD guide on working safely and producing drawings that pass as your own. Nothing in your drawing changes until you ask for a change, and one Undo reverts each change the agent applies.

## Requirements

- **AutoCAD:** full AutoCAD for Windows, running on the same computer as T3 Code. AutoCAD LT and AutoCAD for Mac are not supported.
- **SketchUp:** SketchUp Pro or Studio desktop 2020 or newer, on Windows or macOS. SketchUp Free, SketchUp for Web, and SketchUp Go are not supported.

## Get started

1. Download the latest installer from the [releases page](https://github.com/eduardtomas1/t3code/releases) and run it. It installs T3 Code with the CAD tools, in place of any T3 Code you installed from t3.codes, and later updates come from the same releases page.
2. Open your drawing in AutoCAD, or your model in SketchUp.
3. In a thread, ask the agent to check the CAD apps, for example "what CAD drawings do I have open?" It reports each open drawing and model, and anything you need to fix first.
4. For SketchUp, ask "set up SketchUp" the first time, in a thread with full access. T3 Code installs its extension into every installed SketchUp 2020 or newer. Restart SketchUp afterwards. Ask again after updating T3 Code if the agent says the extension is outdated. AutoCAD needs no setup.
5. Ask about your work, for example "what's selected in my drawing?" or "show me the current view."

## How edits work

1. You ask for a change. The agent prepares it and gets a preview of what each object looks like before and after. The preview never changes your drawing.
2. The agent explains the change in the thread.
3. The agent applies it right away, with no confirmation dialog in the CAD app: asking in the thread is your approval. It can land while you keep working, and the agent checks the result afterwards.
4. Each applied change is a single Undo step in the CAD app.

Each preview can be applied once, within 30 minutes. If the CAD app was busy or another drawing was in front, nothing happened and the agent can try the same preview again. If the objects it changes were edited since the preview, nothing is applied and the agent prepares a new preview. If the agent reports that the outcome is unknown, for example because the CAD app stopped responding, check the drawing before asking it to try again.

## Save a copy

Ask the agent to "save a copy" to keep a snapshot of your work. Copies are always new files and never replace an existing file. By default the copy goes next to the original as `<name> (T3 copy <date and time>)`; only a thread with full access can choose another folder. In AutoCAD, edits the agent applied are in the open drawing until you save it, and the agent can't copy a drawing with unsaved changes, so save it first (Ctrl+S), then ask for the copy.

## New drawings and exports

Agents can also render a drawing to an image or a PDF, export it to DXF, or build a new DWG from a drawing they wrote, using AutoCAD's own engine in the background. They always work on a copy of the saved file: your open drawing never changes. Because they read the last save, save first (Ctrl+S) if you want recent edits included; the agent is told when the open drawing has unsaved changes.

- Exports of your drawings go to T3 Code's own folder, and the agent tells you where. Drawings an agent builds from its own files go next to those files. Nothing replaces a file T3 Code did not write; only a thread with full access can choose another location.
- A new DWG can use one of your drawings as a template: it gets your layers, text and dimension styles, and page setups, while your geometry is left out.
- This needs full AutoCAD for Windows; the agent checks it with "what CAD drawings do I have open?". Files your drawing references by a relative path, such as images or xrefs, don't appear in renders.

## What agents can edit

- **AutoCAD**, in drawing units: add lines, polylines, circles, arcs, text, hatches, and aligned or linear dimensions (in your current dimension style); insert blocks already defined in the drawing; create layers; move, rotate, copy, mirror, scale, offset, and erase objects; change an object's layer or color; change text and block attribute values. New objects go on the current layer unless the agent picks one, with color, linetype, and lineweight ByLayer.
- **SketchUp**, in millimeters: add boxes; create tags and materials; move, erase, hide, or show objects; rename them; change an object's tag or material.

Agents can't change objects inside a block definition in AutoCAD, or inside a component or group in SketchUp that appears more than once, because the edit would change every copy. Objects nested inside a SketchUp group or component that appears only once can be edited. Erasing a SketchUp edge also deletes the faces it bounds; the preview says so. Objects on locked layers in AutoCAD, and locked objects or objects inside locked groups in SketchUp, are refused; unlock them first. Agents can't run commands, scripts, or plugins in the CAD apps.

## Privacy

Drawing data, text, and screenshots that the agent reads are sent to the AI provider the thread uses, like anything else in the conversation. Work on copies of client projects when their terms require it. Files in a OneDrive, Dropbox, or other synced folder can change while you work if someone else edits them, so check the drawing before asking for a change.

## Troubleshooting

- **SketchUp is not running or not found.** Open SketchUp. If you just set it up, restart SketchUp so it loads the extension. If SketchUp was installed recently, open it once before asking the agent to set it up.
- **SketchUp is running but not answering.** Close any open dialog in SketchUp and try again.
- **AutoCAD is busy.** Finish or cancel the current command, and close any open dialog in AutoCAD.
- **AutoCAD is not found.** Make sure full AutoCAD for Windows is open with a drawing.
- **The agent doesn't see new CAD options after an update.** Agents keep the tool list from when their session started. Start a new thread, or a new session in the same thread, after updating T3 Code.
- **Windows blocks the installer.** The installer is not code signed, so Windows SmartScreen may warn about it. Choose **More info**, then **Run anyway**.
- **Install the SketchUp extension by hand.** Download `T3CodeCadBridge.rbz` from the [releases page](https://github.com/eduardtomas1/t3code/releases). In SketchUp, open **Extensions → Extension Manager**, choose **Install Extension**, select the file, and restart SketchUp.
- **Remove the SketchUp extension.** Quit SketchUp, then delete `t3_cad_bridge.rb` and the `t3_cad_bridge` folder from SketchUp's Plugins folder. On Windows that folder is `%APPDATA%\SketchUp\SketchUp 20XX\SketchUp\Plugins`; on macOS it is `~/Library/Application Support/SketchUp 20XX/SketchUp/Plugins`.
