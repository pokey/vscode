/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises } from 'fs';
import { localize } from 'vs/nls';
import { process } from 'vs/base/parts/sandbox/electron-sandbox/globals';
import { AbstractTextFileService } from 'vs/workbench/services/textfile/browser/textFileService';
import { ITextFileService, ITextFileStreamContent, ITextFileContent, IReadTextFileOptions, IWriteTextFileOptions, TextFileEditorModelState, ITextFileEditorModel } from 'vs/workbench/services/textfile/common/textfiles';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { URI } from 'vs/base/common/uri';
import { IFileStatWithMetadata, FileOperationError, FileOperationResult, IFileService, ByteSize, getPlatformLimits, Arch } from 'vs/platform/files/common/files';
import { Schemas } from 'vs/base/common/network';
import { join } from 'vs/base/common/path';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/textResourceConfigurationService';
import { UTF8, UTF8_with_bom } from 'vs/workbench/services/textfile/common/encoding';
import { ITextSnapshot } from 'vs/editor/common/model';
import { IUntitledTextEditorService } from 'vs/workbench/services/untitled/common/untitledTextEditorService';
import { ILifecycleService } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IModelService } from 'vs/editor/common/services/modelService';
import { INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/environmentService';
import { IDialogService, IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IFilesConfigurationService } from 'vs/workbench/services/filesConfiguration/common/filesConfigurationService';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { IPathService } from 'vs/workbench/services/path/common/pathService';
import { IWorkingCopyFileService } from 'vs/workbench/services/workingCopy/common/workingCopyFileService';
import { IUriIdentityService } from 'vs/workbench/services/uriIdentity/common/uriIdentity';
import { IModeService } from 'vs/editor/common/services/modeService';
import { INativeHostService } from 'vs/platform/native/electron-sandbox/native';
import { ILogService } from 'vs/platform/log/common/log';
import { Promises } from 'vs/base/common/async';

export class NativeTextFileService extends AbstractTextFileService {

	constructor(
		@IFileService fileService: IFileService,
		@IUntitledTextEditorService untitledTextEditorService: IUntitledTextEditorService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModelService modelService: IModelService,
		@INativeWorkbenchEnvironmentService protected environmentService: INativeWorkbenchEnvironmentService,
		@IDialogService dialogService: IDialogService,
		@IFileDialogService fileDialogService: IFileDialogService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IFilesConfigurationService filesConfigurationService: IFilesConfigurationService,
		@ITextModelService textModelService: ITextModelService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IPathService pathService: IPathService,
		@IWorkingCopyFileService workingCopyFileService: IWorkingCopyFileService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IModeService modeService: IModeService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILogService logService: ILogService
	) {
		super(fileService, untitledTextEditorService, lifecycleService, instantiationService, modelService, environmentService, dialogService, fileDialogService, textResourceConfigurationService, filesConfigurationService, textModelService, codeEditorService, pathService, workingCopyFileService, uriIdentityService, modeService, logService);
	}

	protected registerListeners(): void {
		super.registerListeners();

		// Lifecycle
		this.lifecycleService.onWillShutdown(event => event.join(this.onWillShutdown(), 'join.textFiles'));
	}

	private async onWillShutdown(): Promise<void> {
		let modelsPendingToSave: ITextFileEditorModel[];

		// As long as models are pending to be saved, we prolong the shutdown
		// until that has happened to ensure we are not shutting down in the
		// middle of writing to the file
		// (https://github.com/microsoft/vscode/issues/116600)
		while ((modelsPendingToSave = this.files.models.filter(model => model.hasState(TextFileEditorModelState.PENDING_SAVE))).length > 0) {
			await Promises.settled(modelsPendingToSave.map(model => model.joinState(TextFileEditorModelState.PENDING_SAVE)));
		}
	}

	async read(resource: URI, options?: IReadTextFileOptions): Promise<ITextFileContent> {

		// ensure size & memory limits
		options = this.ensureLimits(options);

		return super.read(resource, options);
	}

	async readStream(resource: URI, options?: IReadTextFileOptions): Promise<ITextFileStreamContent> {

		// ensure size & memory limits
		options = this.ensureLimits(options);

		return super.readStream(resource, options);
	}

	private ensureLimits(options?: IReadTextFileOptions): IReadTextFileOptions {
		let ensuredOptions: IReadTextFileOptions;
		if (!options) {
			ensuredOptions = Object.create(null);
		} else {
			ensuredOptions = options;
		}

		let ensuredLimits: { size?: number; memory?: number; };
		if (!ensuredOptions.limits) {
			ensuredLimits = Object.create(null);
			ensuredOptions.limits = ensuredLimits;
		} else {
			ensuredLimits = ensuredOptions.limits;
		}

		if (typeof ensuredLimits.size !== 'number') {
			ensuredLimits.size = getPlatformLimits(process.arch === 'ia32' ? Arch.IA32 : Arch.OTHER).maxFileSize;
		}

		if (typeof ensuredLimits.memory !== 'number') {
			const maxMemory = this.environmentService.args['max-memory'];
			ensuredLimits.memory = Math.max(typeof maxMemory === 'string' ? parseInt(maxMemory) * ByteSize.MB || 0 : 0, getPlatformLimits(process.arch === 'ia32' ? Arch.IA32 : Arch.OTHER).maxHeapSize);
		}

		return ensuredOptions;
	}

	async write(resource: URI, value: string | ITextSnapshot, options?: IWriteTextFileOptions): Promise<IFileStatWithMetadata> {

		// check for overwriteReadonly property (only supported for local file://)
		try {
			if (options?.overwriteReadonly && resource.scheme === Schemas.file) {
				const fileStat = await promises.stat(resource.fsPath);

				// try to change mode to writeable
				await promises.chmod(resource.fsPath, fileStat.mode | 0o200 /* File mode indicating writable by owner (fs.constants.S_IWUSR) */);
			}
		} catch (error) {
			// ignore and simply retry the operation
		}

		// check for writeElevated property (only supported for local file://)
		if (options?.writeElevated && resource.scheme === Schemas.file) {
			return this.writeElevated(resource, value, options);
		}

		try {
			return await super.write(resource, value, options);
		} catch (error) {

			// In case of permission denied, we need to check for readonly
			if ((<FileOperationError>error).fileOperationResult === FileOperationResult.FILE_PERMISSION_DENIED) {
				let isReadonly = false;
				try {
					const fileStat = await promises.stat(resource.fsPath);
					if (!(fileStat.mode & 0o200 /* File mode indicating writable by owner (fs.constants.S_IWUSR) */)) {
						isReadonly = true;
					}
				} catch (error) {
					// ignore - rethrow original error
				}

				if (isReadonly) {
					throw new FileOperationError(localize('fileReadOnlyError', "File is Read Only"), FileOperationResult.FILE_READ_ONLY, options);
				}
			}

			throw error;
		}
	}

	private async writeElevated(resource: URI, value: string | ITextSnapshot, options?: IWriteTextFileOptions): Promise<IFileStatWithMetadata> {
		const source = URI.file(join(this.environmentService.userDataPath, `code-elevated-${Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 6)}`));
		const { encoding, addBOM } = await this.encoding.getWriteEncoding(resource, options);
		try {
			// write into a tmp file first
			await this.write(source, value, { encoding: encoding === UTF8 && addBOM ? UTF8_with_bom : encoding });

			// then sudo prompt copy
			await this.nativeHostService.writeElevated(source, resource, options);
		} finally {

			// clean up
			await this.fileService.del(source);
		}

		return this.fileService.resolve(resource, { resolveMetadata: true });
	}
}

registerSingleton(ITextFileService, NativeTextFileService);
