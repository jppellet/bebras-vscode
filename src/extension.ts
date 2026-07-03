// Reference: https://code.visualstudio.com/api/references/vscode-api

import * as vscode from 'vscode'

import * as bebras from 'bebras'
import { QuickFix } from 'bebras/out/check'
import { PluginOptions } from 'bebras/out/convert_html'
import { PluginContext } from 'bebras/out/convert_html_markdownit'
import { tableHeaderOrSepPattern } from 'bebras/out/patterns'
import { isString, isUndefined, mkStringCommaAnd } from 'bebras/out/util'
import * as fs from 'fs'
import * as path from 'path'

// maps containing folder name to list of author completions
type Completions = {
	latestModification: number,
	completions: string[],
}
const AuthorCompletionCache = new Map<string, Completions>()

async function getAuthorCompletions(folderPath: string): Promise<string[]> {
	const completionFile = path.join(folderPath, "authors_completion.txt")

	let completions = AuthorCompletionCache.get(folderPath)
	if (!bebras.util.isUndefined(completions)) {
		let needsReload = false
		if (fs.existsSync(completionFile)) {
			const stats = fs.statSync(completionFile)
			if (stats.mtimeMs > completions.latestModification) {
				// file is newer than the cached version
				needsReload = true
			}
		}
		if (!needsReload) {
			// console.log("using cached completions for: ", folderPath)
			return completions.completions
		}
	}

	if (fs.existsSync(completionFile)) {
		// console.log("loading completions from: ", completionFile)
		const stats = fs.statSync(completionFile)
		const lines = await fs.promises.readFile(completionFile, "utf8")
		const completionLines = lines.split(/\r?\n/).filter(l => l.length > 0)
		completions = {
			latestModification: stats.mtimeMs,
			completions: completionLines.map(line => line.trim()),
		}
		AuthorCompletionCache.set(folderPath, completions)
		return completionLines
	} else {
		console.log("Missing authors completion file: ", completionFile)
		return []
	}
}

let DiscordLinkCache = undefined as undefined | {
	urlPattern: string,
	serverId: string,
	channelIds: Record<string, string>
}

export async function getDiscordLink(folderPath: string, taskId: string): Promise<string | undefined> {
	if (isUndefined(DiscordLinkCache)) {
		// load from file
		const channelsFile = path.join(folderPath, "discord_channels.json")
		if (!fs.existsSync(channelsFile)) {
			console.log("missing file: ", channelsFile)
			return undefined
		}
		const content = await fs.promises.readFile(channelsFile, "utf8")
		const channelsData = JSON.parse(content)
		let channelIds
		if (!isString(channelsData.urlPattern) || !isString(channelsData.serverId) || ((channelIds = channelsData.channelIds) === null) || typeof channelIds !== "object") {
			console.log("malformed JSON: ", channelsData)
			console.log(!isString(channelsData.urlPattern))
			console.log(!isString(channelsData.serverId))
			console.log(channelsData.channelIds)
			console.log(channelIds = channelsData.channelIds === null)
			console.log(typeof channelIds !== "object")
			return undefined
		}

		DiscordLinkCache = {
			urlPattern: channelsData.urlPattern,
			serverId: channelsData.serverId,
			channelIds: channelIds,
		}
	}

	const { urlPattern, serverId, channelIds } = DiscordLinkCache
	const channelId = channelIds[taskId]
	if (isUndefined(channelId)) {
		return undefined
	}
	return urlPattern.replace("${serverId}", serverId).replace("${channelId}", channelId)
}

// Suppresses a pending lint for the specified document
function suppressLint(document: vscode.TextDocument | null) {
	if (throttle.timeout && (document === throttle.document)) {
		clearTimeout(throttle.timeout)
		throttle.document = null
		throttle.timeout = null
	}
}

// Requests a lint of the specified document
function requestLint(document: vscode.TextDocument) {
	suppressLint(document)
	throttle.document = document
	throttle.timeout = setTimeout(() => {
		// Do not use throttle.document in this function; it may have changed
		lint(document)
		suppressLint(document)
	}, throttleDuration)
}

function isTaskDocument(doc: vscode.TextDocument) {
	return doc.languageId === "markdown" && doc.uri.fsPath.endsWith(bebras.patterns.taskFileExtension)
}


function getFilenameAndVersionForLinting(doc: vscode.TextDocument): undefined | { filePath: string, version: string } {
	if (!isTaskDocument(doc)) {
		return undefined
	}

	const filePath = doc.uri.fsPath

	const prologueRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(2, 0))
	const prologue = doc.getText(prologueRange)
	let match
	if (!(match = bebras.patterns.prologue.exec(prologue))) {
		return undefined
	}
	const version = match.groups.version ?? "1.0"

	return { filePath, version }
}

const DiagCode = "bebras"

// Lints a Markdown document
async function lint(doc: vscode.TextDocument) {

	const diags = [] as vscode.Diagnostic[]
	try {

		let basicInfo
		if (!(basicInfo = getFilenameAndVersionForLinting(doc))) {
			return
		}

		const { filePath, version } = basicInfo
		const text = doc.getText()
		const strictChecks = vscode.workspace.getConfiguration("bebras").get("strictChecks", false as boolean)

		const outputs = await bebras.check.check(text, filePath, strictChecks, undefined, version)

		for (const o of outputs) {
			let sev: vscode.DiagnosticSeverity
			switch (o.type) {
				case "error":
					sev = vscode.DiagnosticSeverity.Error
					break
				case "warn":
				default:
					sev = vscode.DiagnosticSeverity.Warning
					break
			};

			const diag = new vscode.Diagnostic(new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end)), o.msg, sev)
			diag.code = DiagCode
			if (o.quickFix) {
				(diag as any).quickFix = o.quickFix
			}
			diags.push(diag)
		}


	} finally {
		diagnosticCollection.set(doc.uri, diags)
	}

}

const throttle = {
	"document": null as (null | vscode.TextDocument),
	"timeout": null as (null | NodeJS.Timeout),
}
const throttleDuration = 500

let diagnosticCollection: vscode.DiagnosticCollection

function didChangeVisibleTextEditors(textEditors: vscode.TextEditor[]) {
	textEditors.forEach((textEditor) => lint(textEditor.document))
}

// Handles the onDidChangeTextDocument event
function didChangeTextDocument(change: vscode.TextDocumentChangeEvent) {
	const doc = change.document
	if (isTaskDocument(doc)) {
		requestLint(doc)
	}
}

// Handles the onDidSaveTextDocument event
function didSaveTextDocument(doc: vscode.TextDocument) {
	if (isTaskDocument(doc)) {
		lint(doc)
		suppressLint(doc)

		const settingsConfig = vscode.workspace.getConfiguration("bebras")

		const autoExportLatex = settingsConfig.get("autoExportLatexOnSave", false as boolean)
		if (autoExportLatex) {
			vscode.commands.executeCommand("bebrasmd.exportTex", { neverOpenAfterExport: true })
		}

		const autoExportServer = settingsConfig.get("autoExportServerOnSave", false as boolean)
		if (autoExportServer) {
			vscode.commands.executeCommand("bebrasmd.exportServerHtml", { neverOpenAfterExport: true })
		}
	}
}

// Handles the onDidCloseTextDocument event
function didCloseTextDocument(document: vscode.TextDocument) {
	suppressLint(document)
	diagnosticCollection.delete(document.uri)
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {


	const extensionDisplayName = "bebras-vscode"

	// Create OutputChannel
	const outputChannel = vscode.window.createOutputChannel(extensionDisplayName)
	context.subscriptions.push(outputChannel)

	// Hook up to workspace events
	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(didChangeVisibleTextEditors),
		vscode.workspace.onDidChangeTextDocument(didChangeTextDocument),
		vscode.workspace.onDidSaveTextDocument(didSaveTextDocument),
		vscode.workspace.onDidCloseTextDocument(didCloseTextDocument),
	)

	// Create DiagnosticCollection
	diagnosticCollection = vscode.languages.createDiagnosticCollection(extensionDisplayName)
	context.subscriptions.push(diagnosticCollection)

	// Cancel any pending operations during deactivation
	context.subscriptions.push({
		"dispose": () => suppressLint(throttle.document),
	})

	// Request (deferred) lint of active document
	if (vscode.window.activeTextEditor) {
		requestLint(vscode.window.activeTextEditor.document)
	}

	function loggingErrors<Args extends any[]>(promiseFct: (...args: Args) => Promise<void>): (...args: Args) => Promise<void> {
		return (...args) => {
			const p = promiseFct(...args)
			return p.catch(err => console.log(err))
		}
	}

	const authorCompletion = {
		async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, cancel: vscode.CancellationToken, ctx: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
			// console.log("authorCompletion.provideCompletionItems")
			if (!isTask(doc)) {
				// console.log(" -> not a task")
				return []
			}

			const LinePrefix = "  - "
			const line = doc.lineAt(pos)
			const match = /^\s*\-?\s*(?<filter>.*?)(?:\s+\(.*)?$/.exec(line.text)
			if (!match) {
				// console.log(" -> no match")
				return []
			}

			// const filter = match.groups?.filter?.toLowerCase()
			// console.log(`filter: '${filter}'`)

			const folderPath = usualFolderWithAllTasksContaining(doc.uri.fsPath)
			// console.log("folderPath: ", folderPath)
			const authors = await getAuthorCompletions(folderPath)
			// console.log("authors: ", authors)
			// const completionAuthors = !filter
			// 	? authors
			// 	: authors.filter(auth => auth.toLowerCase().startsWith(filter))
			const completionAuthors = authors

			const completions = completionAuthors.map(authorString => {
				const item = new vscode.CompletionItem(authorString)
				item.insertText = new vscode.SnippetString(LinePrefix + authorString + ` (\${0:role})`)
				item.keepWhitespace = true
				item.kind = vscode.CompletionItemKind.User
				item.range = line.range
				item.filterText = LinePrefix + authorString
				return item
			})

			return completions
		},
	}

	const taskDocSelector = { scheme: 'file', language: 'markdown', pattern: '**/*' + bebras.patterns.taskFileExtension }

	context.subscriptions.push(
		vscode.commands.registerCommand('bebrasmd.exportHtml', loggingErrors(makeExportHandler("html"))),
		vscode.commands.registerCommand('bebrasmd.exportCuttleHtml', loggingErrors(makeExportHandler("cuttle"))),
		vscode.commands.registerCommand('bebrasmd.exportPdf', loggingErrors(makeExportHandler("pdf"))),
		vscode.commands.registerCommand('bebrasmd.exportTex', loggingErrors(makeExportHandler("tex"))),
		vscode.commands.registerCommand('bebrasmd.exportTexAndOpen', loggingErrors(makeExportHandler("tex", true))),
		vscode.commands.registerCommand('bebrasmd.exportServerHtml', loggingErrors(mergeToServer)),
		vscode.commands.registerCommand('bebrasmd.formatTable', loggingErrors(formatTable)),
		vscode.commands.registerCommand('bebrasmd.openDiscord', loggingErrors(openDiscord)),
		vscode.languages.registerCompletionItemProvider(taskDocSelector, authorCompletion),
		vscode.languages.registerCodeActionsProvider(taskDocSelector, new BebrasQuickFixProvider(), {
			providedCodeActionKinds: BebrasQuickFixProvider.providedCodeActionKinds,
		}),
		vscode.languages.registerHoverProvider(taskDocSelector, { provideHover }),
	)

	let lastActiveTaskEditor: vscode.TextEditor | undefined = undefined
	for (const editor of vscode.window.visibleTextEditors) {
		if (isTask(editor.document)) {
			lastActiveTaskEditor = editor
			break
		}
	}
	// console.log(" =>> last active editor: " + lastActiveTaskEditor?.document.uri.fsPath)
	vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor && isTask(editor.document)) {
			lastActiveTaskEditor = editor
			// console.log(" =>> last active editor: " + editor.document.uri.fsPath)
		}
	})

	return {
		extendMarkdownIt(md: any) {
			try {

				md = md.use(bebras.markdownitPlugin.plugin(() => {
					// console.log("Active: " + vscode.window.activeTextEditor?.document.uri.fsPath)
					// console.log("Last:   " + lastActiveTaskEditor?.document.uri.fsPath)
					const taskFile = (vscode.window.activeTextEditor ?? lastActiveTaskEditor)?.document.uri.fsPath ?? ""
					const basePath = path.dirname(taskFile)
					// console.log("++ basePath: " + basePath)
					const context: PluginContext = { taskFile, basePath, setOptionsFromMetadata: true }
					return context
				}))
				md.set({ quotes: getConfigCustomQuotes() })
			} catch (e) {
				console.error(e)
			}
			return md
		},
	}

}

function usualFolderWithAllTasksContaining(taskPath: string) {
	return path.dirname(path.dirname(taskPath))
}

// this method is called when your extension is deactivated
export function deactivate() { }

export class BebrasQuickFixProvider implements vscode.CodeActionProvider {

	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix,
	]

	provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
		const diags = context.diagnostics
		if (diags.length === 0) {
			return []
		}
		return diags
			.filter(diag => diag.code === DiagCode)
			.flatMap(diag => this.createCommandCodeActions(doc, diag, range))
	}

	private createCommandCodeActions(doc: vscode.TextDocument, diag: vscode.Diagnostic, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
		// console.log("diag", diag)
		const quickFix: undefined | QuickFix = (diag as any).quickFix
		if (!quickFix) {
			return []
		}

		if (quickFix._type === "replacement") {
			return quickFix.values.map(replacement => {
				const action = new vscode.CodeAction(`Replace with '${replacement}'`, vscode.CodeActionKind.QuickFix)
				action.diagnostics = [diag]
				action.edit = new vscode.WorkspaceEdit()
				action.edit.replace(doc.uri, diag.range, replacement)
				return action
			})
		}

		if (quickFix._type === "additions") {
			const action = new vscode.CodeAction(`Insert missing values`, vscode.CodeActionKind.QuickFix)
			action.diagnostics = [diag]
			action.edit = new vscode.WorkspaceEdit()
			let lineNum = range.start.line + 1
			let line: vscode.TextLine
			while ((line = doc.lineAt(lineNum)).text.startsWith(" ")) {
				lineNum++
			}
			action.edit.insert(doc.uri, line.rangeIncludingLineBreak.start, quickFix.newValues.map(v => "  - " + v + "\n").join(""))
			return [action]
		}

		return []
	}
}

function provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): undefined | vscode.Hover {
	const line = doc.lineAt(pos.line).text.trim()
	let match
	if (match = /^\s*(?<key>[a-z0-9\-_]+?):.*$/.exec(line)) {
		const key: string = match.groups!.key
		const desc = makeDesc(key)
		if (desc) {
			return new vscode.Hover(new vscode.MarkdownString(desc))
		}
	}
	return undefined

	function makeDesc(key: string): string | undefined {
		function withStdPrefix(end: string, keyOverride?: string) {
			return `In the task metadata, the **${keyOverride ?? key}** field ` + end
		}
		if (key === "id") {
			return withStdPrefix(`is a string uniquely identifying the task, with the format \`YYYY-CC-NN[v]\`. It should match the name of the task file.\n\nIt should follow this regex pattern:\n\n\`${bebras.patterns.idWithOtherYear}\``)
		} else if (key === "name") {
			return withStdPrefix(`gives the original name of the task, non-localized. It is usually in English and should not really change over multiple revisions of the task. The localized title of the file should go into the **title** field.`)
		} else if (key === "title") {
			return withStdPrefix(`is the localized, changeable title of the task as it will be exported for end-user output files.`)
		} else if (key === "answer_type") {
			return withStdPrefix(`says how this task will be answered by participants. It affects the expected contents of the *${bebras.patterns.markdownSectionNamesFor("latest")[1]}* section.\n\nIt should be one of these values: ${mkStringCommaAnd(bebras.patterns.answerTypesFor("latest").map(a => "`" + a + "`"), "or")}.`)
		} else if (key === "computer_science_areas" || key === "categories") {
			return withStdPrefix(`lists one or more categories under which this task should be classified. They are listed on an indented line with a hyphen.\n\nPossible values are: ${mkStringCommaAnd(bebras.patterns.categories.map(a => "`" + a.name + "`"))}}.`)
		} else if (key === "computational_thinking_skills") {
			return withStdPrefix(`lists one or more computational thinking skills under which this task should be classified. They are listed on an indented line with a hyphen.\n\nPossible values are: ${mkStringCommaAnd(bebras.patterns.ctSkills.map(a => "`" + a + "`"))}}.`)
		} else if (key === "contributors") {
			return withStdPrefix(`lists, each on an indented line with hyphen, the list of contributors for this task.\n\nIn order to be parsed correctly, these lines should have the format:\n\n\`  - Name, email, country (role[s])\`\n\nWrite \`[no email]\` if the email address is not known.\n\nSeparate multiple roles with commas. Recoginzed roles are ${mkStringCommaAnd(bebras.patterns.validRoles.map(a => "`" + a + "`"))}. The role \`${bebras.patterns.roleTranslation}\` should specify *from* and *into* which language translation was gone, e.g.: \`${bebras.patterns.roleTranslation} from English into German\`.`)
		} else if (key === "support_files") {
			return withStdPrefix(`lists the auxiliary files (e.g., graphics) linked to this task. They can have either of two formats. When the author is from the Bebras community, they should be listed in the **contributors** section and referenced by their full name:\n\n\`  - <file_pattern> by <author> (<license>)\`\n\nIf the license is omitted, it is assumed to be \`${bebras.patterns.DefaultLicenseShortTitle}\`. More authors, separated by \`and\` without commas, can be listed.\n\nIf the file comes from an external source, use:\n\n\`  - <file_pattern> from <source> (<license>)\`\n\nHere, the license cannot be omitted.\n\nIn both cases, the file pattern can omit the containing folders, if any, and can be either a normal file name or a [glob pattern](https://en.wikipedia.org/wiki/Glob_(programming)) like \`*.svg\` to reference all SVG files.\n\nWhen checking for missing or extra lines, the glob patterns are tested in order with all auxiliary task files.`)
		} else {
			const ageCats = Object.values(bebras.patterns.ageCategories)
			if (key === "ages" || ageCats.includes(key as any)) {
				return withStdPrefix(`gives an indication of which age categories this task is meant for and of the expected difficulty it represents.\n\nThe age groups are ${mkStringCommaAnd(ageCats?.map(a => "`" + a! + "`")!)}; possible difficulties are \`easy\`, \`medium\`, or \`hard\`, or \`--\` when not applicable to this age category.\n\nIn the rare event that a task is assigned to several non-contiguous age categories, the skipped categories should be annotated with \`----\` to indicate the gap is voluntary.`, "ages")
			}
		}
		return undefined
	}
}


function isTask(doc: vscode.TextDocument): boolean {
	const uri = doc.uri
	if (uri.scheme !== "file") {
		return false
	}

	const fileName = path.basename(uri.fsPath)
	if (!fileName.endsWith(bebras.patterns.taskFileExtension)) {
		return false
	}

	return true
}

function getConfigCustomQuotes(): [string, string] | [string, string, string, string] | undefined {
	const customQuotes = vscode.workspace.getConfiguration("bebras").get("customQuotes", "")
	if (customQuotes.length > 0) {
		return bebras.convert_html.parseQuotes(customQuotes)
	}
	return undefined
}

async function mergeToServer() {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		return
	}

	const doc = editor.document
	if (!isTask(doc)) {
		return
	}

	const taskFile = doc.uri.fsPath

	const server = bebras.cli.bebras_server
	const [taskSpecs, context] = server.buildTaskSpecsFromFiles([taskFile], false)

	const modifiedFiles = await server.runInsertTaskOn(taskSpecs, ["answer", "itsinformatics"], true, false, context)
	if (modifiedFiles.length !== 0) {
		vscode.window.setStatusBarMessage("Wrote " + modifiedFiles[0], 2000)
	}

}

function makeExportHandler(outputFormat: bebras.util.OutputFormat, forceOpenAfterExport: boolean = false) {
	return async (options?: { neverOpenAfterExport: boolean }) => {
		const editor = vscode.window.activeTextEditor
		if (!editor) {
			return
		}

		const doc = editor.document
		if (!isTask(doc)) {
			return
		}

		const taskFile = doc.uri.fsPath
		const defaultOutUri = vscode.Uri.file(bebras.util.defaultOutputFile(taskFile, outputFormat))
		// const outUri = await vscode.window.showSaveDialog({ defaultUri: defaultOutUri })
		const outUri = defaultOutUri
		if (!outUri) {
			return
		}


		const outFile = outUri.fsPath
		const conversionFct = (bebras as any)["convert_" + outputFormat]["convertTask_" + outputFormat]

		const isTextFormat = outputFormat !== "pdf"

		// check if we are allowed to open it
		let openAfterExport: boolean
		if (options?.neverOpenAfterExport) {
			// command invoked with explicit option to never open
			openAfterExport = false
		} else if (forceOpenAfterExport) {
			// callback created with option to always open
			openAfterExport = true
		} else {
			// according to user settings
			const autoOpenSetting = vscode.workspace.getConfiguration("bebras").get("autoOpenExportedFiles", "Never" as string)
			switch (autoOpenSetting) {
				case "Always":
					openAfterExport = true
					break
				case "Only text files": {
					openAfterExport = isTextFormat
					break
				}
				case "Never":
				default:
					openAfterExport = false
			}
		}

		vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, async (progress) => {
			progress.report({
				message: `Converting task to ` + outputFormat,
			})
			try {
				const customOptions: Partial<PluginOptions> = {}

				const customQuotes = getConfigCustomQuotes()
				if (customQuotes !== undefined) {
					customOptions.customQuotes = customQuotes
				}

				const writtenPath: string | true = await conversionFct(taskFile, outFile, customOptions)
				if (writtenPath === true) {
					// written to stdout, shouldn't be the case from the plugin
				} else {
					vscode.window.setStatusBarMessage("Wrote " + formatRelativePathFor(outFile, taskFile), 2000)
					if (openAfterExport) {
						const outFileUri = vscode.Uri.file(writtenPath)

						let openInternal: boolean
						const openInternalSetting = String(vscode.workspace.getConfiguration("bebras").get("openExportedFilesInVSCode", "Only text files" as string))
						switch (openInternalSetting) {
							case "Never":
							case "false": // old setting
								openInternal = false
								break
							case "Always":
							case "true": // old setting
								openInternal = true
								break
							case "Only text files":
							default: {
								openInternal = isTextFormat
							}
						}


						if (openInternal) {
							focusEditorForOrOpenFile(outFileUri)
						} else {
							try {
								await vscode.commands.executeCommand("openInExternalApp.open", outFileUri)
							} catch (err) {
								focusEditorForOrOpenFile(outFileUri)
							}
						}

					}
				}
			} catch (err) {
				console.error(err)
			}
		})
	}
}

function focusEditorForOrOpenFile(uri: vscode.Uri) {
	const wantedPath = uri.fsPath
	// console.log("wantedPath: " + wantedPath)
	for (const editor of vscode.window.visibleTextEditors) {
		// console.log("editor:     " + editor.document.uri.fsPath)
		if (editor.document.uri.fsPath === wantedPath) {
			vscode.window.showTextDocument(editor.document)
			return
		}
	}
	vscode.commands.executeCommand("vscode.open", uri)
}

function eolIn(doc: vscode.TextDocument): string {
	switch (doc.eol) {
		case vscode.EndOfLine.CRLF: return "\r\n"
		case vscode.EndOfLine.LF: return "\n"
	}
	return "\n"
}

async function formatTable() {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		return
	}

	const doc = editor.document
	if (!isTask(doc)) {
		return
	}

	const selection = editor.selection

	// expand to the whole table
	function looksLikeTableLine(line: vscode.TextLine): boolean {
		if (line.text.includes("|")) {
			return true
		}
		if (line.text.includes("‖")) {
			return true
		}
		if (tableHeaderOrSepPattern.test(line.text)) {
			return true
		}
		return false
	}

	let startLine = selection.start.line
	if (!looksLikeTableLine(doc.lineAt(selection.start.line))) {
		return
	}
	while (startLine > 0 && looksLikeTableLine(doc.lineAt(startLine - 1))) {
		startLine--
	}
	let endLine = selection.end.line
	while (endLine < doc.lineCount - 1 && looksLikeTableLine(doc.lineAt(endLine + 1))) {
		endLine++
	}
	const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine + 1, 0))
	const tableText = doc.getText(range)
	editor.edit(builder => {
		const newText = bebras.check.formatTable(tableText, eolIn(doc))
		builder.replace(range, newText)
		const numNewLines = newText.split(/\r?\n/).length
		editor.selection = new vscode.Selection(range.start, new vscode.Position(range.start.line + numNewLines - 1, 0))
	})
}

async function openDiscord() {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		return
	}

	const doc = editor.document
	if (!isTask(doc)) {
		return
	}


	const taskPath = doc.uri.fsPath
	const taskFileName = path.basename(taskPath)
	let match
	if (!(match = bebras.patterns.taskFileName.exec(taskFileName))) {
		console.log("malformed file name: " + taskFileName)
		return
	}
	const taskId = match.groups.id
	const tasksFolder = usualFolderWithAllTasksContaining(taskPath)
	const channelUrl = await getDiscordLink(tasksFolder, taskId)

	if (isUndefined(channelUrl)) {
		return
	}

	vscode.env.openExternal(vscode.Uri.parse(channelUrl))
}

function formatRelativePathFor(outFile: string, taskFile: string) {
	const folder = path.dirname(taskFile) + '/'
	if (outFile.startsWith(folder)) {
		outFile = path.join(path.basename(folder), outFile.substring(folder.length))
	}
	return outFile
}
