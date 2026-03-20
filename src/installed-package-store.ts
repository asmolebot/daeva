import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseInstalledPackageMetadataCollection } from './manifest-loader.js';
import type { InstalledPackageMetadata, InstalledPackageMetadataCollection } from './types.js';

export interface InstalledPackageStoreOptions {
  storageFilePath?: string;
}

export class InstalledPackageStore {
  readonly storageFilePath: string;

  constructor(options: InstalledPackageStoreOptions = {}) {
    this.storageFilePath = options.storageFilePath ?? path.resolve(process.cwd(), '.data/installed-packages.json');
  }

  list(): InstalledPackageMetadata[] {
    return this.readCollection().packages;
  }

  upsert(entry: InstalledPackageMetadata): InstalledPackageMetadata {
    const collection = this.readCollection();
    const packages = collection.packages.filter((pkg) => pkg.alias !== entry.alias);
    packages.push(entry);
    const nextCollection: InstalledPackageMetadataCollection = {
      schemaVersion: '1',
      packages: packages.sort((left, right) => left.alias.localeCompare(right.alias))
    };
    this.writeCollection(nextCollection);
    return entry;
  }

  private readCollection(): InstalledPackageMetadataCollection {
    try {
      const raw = readFileSync(this.storageFilePath, 'utf8');
      return parseInstalledPackageMetadataCollection(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: '1', packages: [] };
      }

      throw error;
    }
  }

  private writeCollection(collection: InstalledPackageMetadataCollection): void {
    mkdirSync(path.dirname(this.storageFilePath), { recursive: true });
    writeFileSync(this.storageFilePath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
  }
}
