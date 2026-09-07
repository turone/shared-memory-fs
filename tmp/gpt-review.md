Проведи целостный архитектурный рефакторинг ветки VFS репозитория shared-memory-fs.

Это не локальный patch. Мы начинали с аудита багов, но в процессе уточнили целевую архитектуру Place, доменов, providers, fs routing, snapshot, watcher, CommonJS и ESM loaders.

Библиотека ещё не используется внешними потребителями. Обратная совместимость со старой конфигурацией и старым публичным API не требуется. Не добавляй compatibility layers, deprecated aliases и двойные модели только ради старых тестов.

Работай в Metarchy-стиле:
- только Node.js standard library, кроме уже используемых зависимостей проекта;
- без Express и дополнительных frameworks;
- небольшие модули с ясной ответственностью;
- один источник истины для каждого понятия;
- не вводить сложные абстракции без реального текущего потребителя.

Сначала внимательно изучи:
- README.md
- .github/instructions/VFS.instructions.md
- index.js
- package.json
- все файлы lib/**
- все tests и fixtures

VFS.instructions.md является историческим описанием замысла, а не безусловной инструкцией. Обнови его по итоговой архитектуре. Если старый документ противоречит этому prompt или фактическому исправленному дизайну, следуй этому prompt и обнови документ.

Перед изменениями составь внутреннюю карту зависимостей, но не останавливайся для согласования. Реализуй задачу полностью, запусти tests и предоставь итоговый отчёт.

==================================================
1. ЦЕЛЕВАЯ МОДЕЛЬ PLACE
==================================================

Один Place соответствует ровно одному mount и одной физической директории под appRoot.

Ключ объекта places одновременно является:
- именем Place;
- именем директории относительно appRoot;
- mount;
- cache namespace;
- snapshot identifier;
- delta target.

Пример:

places: {
  public: {
    provider: 'sab',
    fs: true,
  },
}

означает директорию:

<appRoot>/public

Поле dir полностью удалить. Обратная совместимость с ним не нужна.

Один mount может принадлежать только одному Place. Если одна директория используется через fs, require и import, это один Place с несколькими доменами, а не несколько Places.

Provider относится ко всему Place:
- sab
- memory
- sea
- disk
- node-default

Raw source принадлежит Place целиком и не дублируется между доменами.

Scanner и watcher запускаются один раз на Place.

Домены описывают поведение интерфейсов над общей raw-проекцией:
- fs
- require
- import

==================================================
2. ИМЕНА PLACE
==================================================

Имена Place должны быть ASCII-only.

Разрешённый базовый формат:
- A-Z
- a-z
- 0-9
- точка
- underscore
- hyphen
- первый символ должен быть буквой или цифрой

Исходный регистр сохраняется.

Запрещать:
- пустое имя;
- "." и "..";
- slash;
- backslash;
- NUL;
- trailing dot;
- абсолютные и вложенные пути;
- Windows reserved names без учёта регистра, включая варианты с расширением.

Два имени, одинаковые после toLowerCase(), являются конфликтом независимо от платформы:

Static
static

Такая конфигурация должна отклоняться.

==================================================
3. НОВАЯ КОНФИГУРАЦИЯ ДОМЕНОВ
==================================================

Корневые старые поля удалить:
- domains
- dir
- ext
- compile
- compress
- extOnExtra
- writable

Целевая форма:

places: {
  public: {
    provider: 'sab',
    maxFileSize: '20 mib',

    fs: {
      ext: ['html', 'css', 'js'],
      writable: true,
      exposeSharedMemory: false,

      compress: {
        encodings: ['br', 'gzip'],
        ext: 'compressible',
        retainRaw: true,

        options: {
          br: {
            level: 5,
          },
        },
      },
    },

    require: {
      ext: ['js', 'cjs', 'json'],
      compile: true,
    },

    import: {
      ext: ['js', 'mjs', 'json'],
    },
  },
}

Для каждого домена:
- поле отсутствует или false означает disabled;
- true включает домен с настройками по умолчанию;
- object включает домен и задаёт overrides.

fs:true:
- fs включён;
- ext отсутствует, значит fs видит все raw-файлы Place;
- writable default false;
- exposeSharedMemory default false;
- compression default disabled.

require:true:
- эквивалентно require:{ compile:true };
- default ext: ['js', 'cjs', 'json'].

require:{ compile:false }:
- включает CommonJS routing без V8 cached-data generation.

import:true:
- default ext: ['js', 'mjs', 'json'].

Явный domain ext заменяет default этого домена.

Корневого ext нет.

==================================================
4. PREINITIALIZATION EXTENSIONS
==================================================

До сканирования вычисляй один внутренний scanExt для Place.

Правила:

1. Если fs включён без ext, scanExt = null, то есть scanner принимает все расширения. Дополнять его require/import extensions уже не нужно.

2. Иначе scanExt является детерминированным union ext всех включённых доменов.

Порядок:
- fs
- require
- import

Дубликаты удаляются с сохранением первого порядка.

Пример:

fs.ext = ['html', 'css', 'js']
require.ext = ['js', 'cjs', 'json']
import.ext = ['js', 'mjs', 'json']

scanExt:
['html', 'css', 'js', 'cjs', 'json', 'mjs']

Scanner загружает raw-файл один раз.

Каждый domain затем отдельно проверяет собственный ext:
- fs определяет файловую видимость и compression;
- require определяет CommonJS routing и bytecode;
- import определяет ESM routing.

==================================================
5. PROVIDER SEMANTICS
==================================================

sab:
- scanner загружает raw files в SAB;
- files больше maxFileSize или не помещающиеся из-за общего SAB budget могут стать disk entries;
- require.compile может создавать bytecode companion;
- fs.compress может создавать compressed companions;
- fs.writable:true пишет на диск, затем watcher асинхронно обновляет SAB.

memory:
- per-thread isolated Map;
- не передаётся в snapshot;
- fs.writable:true изменяет локальный Map;
- require.compile:true создаёт bytecode при write/append/rename соответствующего source;
- никакой автоматической disk synchronization.

sea:
- assets загружаются в SAB;
- writable всегда false;
- sea + fs.writable:true является config error;
- require compilation может быть разрешена;
- ESM source может использовать import domain.

disk:
- managed passthrough mount;
- не сканируется;
- не заполняет Place entries;
- не использует FilesystemCache;
- routeByMount определяет принадлежность;
- разрешённые операции передаются оригинальному node:fs;
- require/import используют стандартные Node file semantics;
- disk + require:true является config error, так как shorthand включает compile:true;
- для managed CommonJS passthrough пользователь обязан указать:

require: {
  compile: false,
}

- disk + require:{compile:true} является config error.

node-default:
- сохраняет обычную Node semantics;
- не сканируется;
- не создаёт vfs: URLs;
- require.compile:true запрещено.

Для disk и node-default exposeSharedMemory:true является config error.

==================================================
6. PUBLIC API
==================================================

Публичный файловый accessor:

const files = kernel.fs('public');

Не использовать getPlace(name, domain).

Термин Place остаётся внутренним архитектурным понятием.

kernel.fs(name):
- возвращает FS facade, если Place существует и fs-domain включён;
- бросает понятную ошибку для неизвестного Place;
- бросает отдельную понятную ошибку, если Place существует, но fs disabled;
- доступен только после successful initialization.

Публичные require/import view objects пока не создавать. Require и import являются routing domains для hooks.

Internal raw Place не должен экспортироваться как пользовательский facade.

==================================================
7. FS WRITABLE POLICY
==================================================

writable находится внутри fs:

fs: {
  writable: true,
}

Provider определяет механизм записи.

sab + writable:true:
- write/append/unlink/mkdir/rm/rename выполняются через оригинальный node:fs;
- watcher затем обновляет raw SAB, bytecode и compression;
- модель eventual consistency;
- успешная запись на диск не гарантирует немедленного обновления SAB;
- watcher для writable SAB обязателен и запускается автоматически.

memory + writable:true:
- изменяется локальный per-thread Map.

sea:
- любые mutations возвращают EROFS.

fs.writable:false:
- mutations возвращают EROFS.

disk:
- managed Node disk semantics с учётом writable policy.

node-default:
- обычный passthrough.

==================================================
8. ЕДИНАЯ FS ROUTING MODEL
==================================================

Убрать из adapters хаотичную комбинацию:
- resolveFsPath()
- isStrictDenied()
- routeWrite()
- дополнительный place.files.get()
- проверки file.data === null

Ввести явные kernel routers.

routeFsRead(path) возвращает структурированное решение:
- shared
- memory
- disk
- passthrough
- missing
- deny

routeFsMutation(path, operation) возвращает:
- memory
- disk
- passthrough
- deny

deny содержит:
- EACCES для strict sandbox denial;
- EROFS для read-only Place;
- ENOTSUP для неподдерживаемой операции provider-а;
- при необходимости другие стандартные коды.

fs-patch не должен повторно интерпретировать config. Он только исполняет решение router-а.

Неподдерживаемая операция никогда не должна случайно перейти к диску и обойти sandbox.

==================================================
9. STRICT SANDBOX
==================================================

strict:true означает Published-entry sandbox с provider-aware semantics.

Для indexed providers:
- sab
- memory
- sea

чтение разрешено только для опубликованной entry, доступной fs-domain.

Неопубликованный файл внутри известного indexed mount:
- EACCES;
- не делать disk fallback.

Файл под appRoot в неизвестном mount:
- EACCES.

Explicit disk entry внутри SAB Place:
- разрешённый disk fallback только для этой entry.

Для disk Place файлового индекса нет:
- весь mount является managed passthrough;
- доступ определяет mount и fs policy.

Для node-default:
- ordinary passthrough policy.

Пути вне appRoot сохраняют обычный Node passthrough.

При strict:false:
- VFS hit обслуживается VFS;
- допустимый VFS miss может перейти Node;
- disk/node-default сохраняют passthrough.

Mutation может создавать новый файл, поэтому для writable mount наличие existing entry не требуется.

==================================================
10. SYMLINK POLICY
==================================================

При strict:true:
- scanner не публикует symlinks;
- symlink на файл пропускается;
- symlink на каталог не обходится;
- debug-only diagnostic.

При strict:false:
- symlink на обычный файл может сохранить текущее совместимое поведение;
- symlink-каталоги не обходить;
- после stat принимать только stat.isFile();
- FIFO, socket, devices и другие special entries не публиковать.

unlink symlink в writable disk/SAB mount удаляет саму ссылку через Node, не target.

==================================================
11. ПОДДЕРЖИВАЕМЫЙ FS API
==================================================

Полную совместимость со всем node:fs пока не обещать.

Поддержать sync, callback и promises forms там, где соответствующая форма существует, для следующего набора:

Reading:
- readFile
- stat
- existsSync
- access
- createReadStream
- readdir

Mutations:
- writeFile
- appendFile
- unlink
- mkdir
- rm
- rename

Для disk и node-default через passthrough сохранить все native options.

Для memory реализовать описанную VFS semantics.

Для read-only Place mutations возвращают EROFS.

Для memory неподдерживаемые операции возвращают ENOTSUP.

==================================================
12. READFILE И SHARED MEMORY EXPOSURE
==================================================

Добавить:

fs: {
  exposeSharedMemory: false,
}

Default false.

readFile():
- всегда возвращает owned Buffer copy;
- с encoding возвращает string;
- поддерживает AbortSignal;
- пользователь может безопасно изменять результат.

readFileView():
- доступен только при exposeSharedMemory:true;
- для sab/sea возвращает direct Buffer view над SAB;
- для memory возвращает direct internal Buffer;
- для disk/node-default возвращает ENOTSUP;
- при exposeSharedMemory:false возвращает ENOTSUP.

Direct views являются borrowed mutable references. JavaScript не обеспечивает read-only Buffer view.

Документировать:
- не изменять direct views;
- не удерживать их после текущей операции;
- после watcher update их актуальность не гарантируется;
- после reuse старого allocation содержимое может относиться к другим данным;
- если данные нужны позже, делать Buffer.from(view);
- library не отслеживает ранее выданные views;
- ответственность за lifetime и freshness лежит на caller.

Не добавлять сейчас:
- Symbol.dispose lease;
- reference counting;
- release protocol;
- FinalizationRegistry;
- allocation IDs для views.

==================================================
13. CREATEREADSTREAM
==================================================

Для sab/sea/memory возвращать ordinary Readable, не полноценный fs.ReadStream.

Поддержать:
- start
- end
- encoding
- highWaterMark
- AbortSignal

Правила:
- start/end являются relative file offsets;
- end inclusive;
- сначала проверять logical offsets, затем прибавлять backing-buffer offset;
- отрицательные, дробные, NaN, Infinity и unsafe values запрещены;
- start > end запрещён;
- range за пределами файла даёт RangeError;
- HTTP clipping и HTTP 416 принадлежат внешнему HTTP layer;
- default highWaterMark 64 KiB.

При exposeSharedMemory:true:
- chunks являются direct mutable views;
- caller обязан считать их borrowed read-only references.

При exposeSharedMemory:false:
- chunks являются owned copies.

Zero-copy chunk никогда не должен выходить за диапазон текущего file entry.

==================================================
14. LAZY VFSSTATS И VFSDIRENT
==================================================

Не хранить полноценные Stats/Dirent в SAB, snapshot или delta.

Entries постоянно хранят только компактную metadata, минимум:
- size
- mtimeMs

VfsStats создаётся лениво при stat().

Минимальный facade:
- size
- mtimeMs
- mtime
- isFile() => true
- isDirectory() => false
- isSymbolicLink() => false

Поддержать { bigint:true } отдельным ленивым facade.

Не кешировать VfsStats между calls.

Не дополнять SAB metadata disk stat-ом после watcher publication, чтобы не смешивать разные epochs.

Disk/node-default возвращают настоящий Node Stats.

VfsDirent создаётся лениво для readdir({withFileTypes:true}).

Минимум:
- name
- isFile()
- isDirectory()
- isSymbolicLink() => false

==================================================
15. READDIR
==================================================

Для sab/sea/memory вычислять readdir проходом по published Place entries.

Не создавать persistent directory index.

Поддержать:
- encoding
- withFileTypes
- recursive

Правила:
- без recursive возвращать direct children;
- с recursive возвращать всё subtree;
- directories являются implicit и выводятся из file paths;
- companions никогда не показывать;
- применять fs-domain ext policy;
- deterministic lexicographic ordering;
- missing directory => ENOENT;
- file used as directory => ENOTDIR.

Disk/node-default используют native passthrough.

==================================================
16. ACCESS И EXISTSSYNC
==================================================

Для virtual indexed providers использовать routing and policy, не строить POSIX permission model.

F_OK:
- entry существует и доступна fs-domain.

R_OK:
- published sab/sea/memory entry readable.

W_OK:
- зависит от fs.writable.

X_OK:
- для virtual entries EACCES.

Комбинированные flags проверяются совместно.

sab + fs.writable:true проходит W_OK.

existsSync:
- использует ту же routing semantics;
- никогда не бросает;
- возвращает boolean.

Disk/node-default используют native Node behavior.

==================================================
17. MEMORY MUTATION SEMANTICS
==================================================

writeFile:
- canonicalize единственный legacy case: key без leading slash получает slash;
- сохранять только canonical key;
- запретить пустой key, NUL и traversal segment "..";
- обновить size и mtimeMs;
- перестроить нужные domain representations.

appendFile:
- использовать простой Buffer.concat;
- отсутствующий файл создаётся;
- не вводить chunked storage;
- обновить metadata и representations.

mkdir:
- успешный no-op;
- directory entries не хранить;
- directories implicit.

unlink:
- удалить exact source;
- удалить связанные bytecode/compression companions.

rm:
- поддержать recursive и force;
- recursive удаляет всё logical subtree и companions;
- без recursive непустой implicit directory даёт Node-like error;
- maxRetries/retryDelay для memory не эмулировать.

rename:
- внутри одного memory Place переименовать source и companions;
- внутри одного writable SAB/disk Place использовать native rename;
- между Places возвращать EXDEV;
- не реализовывать copy + delete.

==================================================
18. КЛЮЧИ ФАЙЛОВ
==================================================

Internal canonical source key:
- начинается с "/".

Public reading:
- сначала exact Map lookup;
- если miss и key не начинается с "/", повторить lookup с leading slash;
- не создавать alias в Map;
- не выполнять другие legacy normalizations.

Все public read methods должны использовать единый lookup:
- readFile
- readFileView
- stat
- exists
- createReadStream
- readdir-related lookup
- compression methods

Для write/mutation:
- key без slash canonicalize;
- сохранять только canonical form;
- запретить NUL и traversal.

Не делать URL decoding внутри Place/FS facade.
OS path normalization остаётся Registry/adapters.
URL decoding остаётся URL/HTTP layer.

==================================================
19. COMPANION KEYS
==================================================

Сохранить NUL как internal separator, но типизировать keys.

Использовать отдельные helpers:

bytecodeKey(source):
  <source>\0require:bytecode

compressedKey(source, encoding):
  <source>\0fs:<encoding>

Убрать semantic dependence от общего произвольного companionKey(key, tag), где это возможно.

Правила:
- public source keys не содержат NUL;
- companions скрыты от readFile, exists, readdir и path routing;
- compression API принимает только configured encoding;
- bytecode недоступен через compression API;
- публичный getCachedData не нужен;
- require pipeline получает bytecode через internal API.

==================================================
20. COMPRESSION API
==================================================

Публичный FS facade:

storedEncodings(key)

readFileCompressed(key, encoding)
- возвращает owned Buffer copy.

readFileCompressedView(key, encoding)
- direct borrowed view только при exposeSharedMemory:true.

statCompressed(key, encoding)
- lightweight lazy metadata result.

createReadStreamCompressed(key, encoding, options)
- применяет ту же copy/shared-chunk policy.

Range относится к compressed bytes.

HTTP negotiation, Accept-Encoding, Content-Encoding, Vary и HTTP 416 не реализовывать в VFS.

==================================================
21. CACHE ALLOCATION И SIZE VALIDATION
==================================================

Добавить строгую numeric validation:
- memory.limit positive safe integer;
- memory.segmentSize positive safe integer;
- global memory.maxFileSize positive safe integer;
- Place maxFileSize positive safe integer;
- zero, negative, fractional, NaN, Infinity invalid;
- memory.limit = 0 invalid;
- compaction.threshold in 0..1;
- threshold 0 disables compaction;
- watchTimeout safe integer >= 0.

Проверить actual behavior metawatch timeout:0 через test перед обещанием exact semantics.

Effective base segment size:

ceil(maxRawFileSize / configuredSegmentSize) * configuredSegmentSize

memory.limit должен быть не меньше effective base segment size для SAB-backed Places. Иначе config error.

place.maxFileSize применяется только к raw source.

Не применять place.maxFileSize к:
- bytecode;
- gzip;
- deflate;
- br;
- zstd.

Derived representation:
- обязано помещаться в один base segment;
- ограничивается общим SAB budget;
- всегда fallback:false;
- если не помещается, representation пропускается;
- raw source продолжает работать.

В SegmentRegistry.allocate() явно отклонять:
- invalid size;
- size > baseSegmentSize.

Если compressed representation больше baseSegmentSize:
- отменить только этот codec;
- продолжить другие codecs;
- при hot reload удалить старое representation этого codec в той же epoch;
- выдать ясную debug/warning diagnostic с причиной.

Не создавать отдельный SAB pool, module pool, compression limit, bytecode limit или reserve.

==================================================
22. SOURCE READ CORRECTNESS
==================================================

При чтении path-based source в SAB:

1. Scanner/watcher предоставляет expected size и mtimeMs.
2. Reader открывает file handle.
3. fh.stat() перед чтением должен совпасть по size и mtimeMs.
4. Читать циклом, учитывая bytesRead.
5. bytesRead === 0 до заполнения expected size означает unexpected EOF.
6. После чтения снова fh.stat().
7. size и mtimeMs до/после должны совпасть.
8. Только после успеха entry публикуется.
9. При ошибке только что выделенный extent освобождается.

Не вводить отдельную transaction subsystem, staging pool или complex allocation object.

Initial load:
- I/O error, short read или source changed during read прерывает initialize();
- disk fallback для такой ошибки не использовать;
- bootstrap должен завершиться с информативной ошибкой;
- planned disk fallback остаётся только для maxFileSize, SAB budget и retainRaw policy.

Watcher:
- failed/unstable source update не публиковать;
- освободить новую allocation;
- сохранить прежний source и companions;
- остальная epoch продолжается;
- сообщение только через debug;
- после epoch выполнить одну deferred debounce recheck;
- repeated failure не запускает infinite retry;
- затем ждать реальное watcher event;
- delete отменяет deferred recheck;
- deduplicate repeated path events.

Buffer-based inputs:
- actual size = data.length;
- если provided stat.size существует и не совпадает, ошибка до allocation.

==================================================
23. MODULE CACHE И STALE BYTECODE
==================================================

require.compile:true строит V8 cached data для CommonJS .js/.cjs source.

Bytecode является best-effort optimization.

Всегда allocate bytecode с fallback:false.

При hot reload:

Success:
- publish new source and new bytecode in same epoch;
- retire old source/bytecode after ACK.

Compilation or allocation failure:
- publish new source;
- remove old bytecode in same epoch;
- free old bytecode after ACK.

Syntax-invalid source всё равно публикуется. VFS отражает current file state, а не last-known-good state.

Unstable or failed source read:
- не публиковать новую source;
- сохранить старый source and bytecode.

Изменить compileFromEntry contract, чтобы он не терял информацию о failure and old bytecode. Использовать structured result, например built/failed.

==================================================
24. REQUIRE HOOK BUG FIXES
==================================================

Исправить critical double execution bug.

Сейчас общий try/catch охватывает compiledWrapper.apply(), поэтому exception из пользовательского module body приводит к fallback и повторному выполнению source.

Новая фаза:

1. create vm.Script with cachedData;
2. if cachedDataRejected, fallback to originalCompile;
3. obtain compiled wrapper;
4. preparation errors may fallback;
5. call compiledWrapper.apply() outside optimization try/catch;
6. module body exception выходит наружу и никогда не вызывает повторный compile.

Сохранить cachedDataRejected check.

Проверить реальный filename used during bytecode creation and require consumption. Cached data должно фактически приниматься V8, а не постоянно fallback-иться.

Проверить this.loaded:
- внутри module body module.loaded должен быть false;
- после successful require cache entry loaded true;
- обычный и bytecode paths одинаковы;
- circular dependency behavior не ломается.
Если Node outer loader сам корректно устанавливает loaded, удалить manual this.loaded = true.

==================================================
25. COMMONJS RESOLUTION
==================================================

Для SAB/SEA/memory реализовать ограниченный Node-like resolution.

LOAD_AS_FILE order:
- exact path
- .js
- .cjs
- .json

LOAD_AS_DIRECTORY:
- package.json
- поддержать только main
- затем index.js
- index.cjs
- index.json

Не реализовывать собственные:
- exports
- imports
- node_modules search
- conditional exports
- native .node loading from SAB

Bare specifiers and packages передавать standard Node resolver, если policy позволяет.

Bytecode только для .js/.cjs.
JSON без bytecode.

Missing unpublished VFS module under strict не должен скрыто читаться с диска.

==================================================
26. ESM RESOLUTION И URL
==================================================

Использовать canonical internal URL:

vfs:file:///absolute/path/module.mjs

Вложенный file URL создавать только pathToFileURL().
Разбирать только fileURLToPath().

Добавить private helpers:
- toVfsUrl(filePath)
- fromVfsUrl(url)
- parentURLToPath(url), поддерживающий file: и vfs:file:

vfs:file: является internal transport URL.
Пользователь использует ordinary Node specifiers.

Поддерживать:
- explicit relative file specifiers;
- explicit absolute path specifiers.

Extension mandatory.
Не подставлять .js/.mjs.
Не поддерживать directory import.
Не читать package.json main для ESM.

Bare package and node: specifiers оставлять standard Node resolver.

SAB/SEA/memory entries получают vfs:file: URL.
Disk/node-default остаются ordinary file:.

Собственный vfs: URL никогда не передавать next/default loader.

Missing module from VFS chain должен давать controlled error с code ERR_MODULE_NOT_FOUND.

Reject or explicitly handle query/fragment. Не допускать multiple accidental identities одного file.

JSON должен соблюдать Node import attributes.

.js в VFS import domain трактовать как ESM согласно documented VFS policy. Не строить сейчас package type resolution.

Node caches ESM per worker by canonical URL.
Raw source shared in SAB.
Compilation/runtime state remains per worker.
ESM V8 cached data не реализовывать.

==================================================
27. ESM LOADER STATE TRANSFER
==================================================

Не предполагать, что process Symbol или global object автоматически виден loader realm.

Добавить настоящий process-level integration test через module.register and --import bootstrap.

Сначала проверить, может ли loader получить ready kernel/state существующим способом.

Если direct object sharing не работает:
- не передавать целый VFSKernel;
- передать resolved serializable config and snapshot through module.register data;
- loader создаёт read-only projection.

Unit tests прямого вызова hook functions не заменяют end-to-end test.

==================================================
28. SNAPSHOT И DELTA
==================================================

Snapshot:

{
  segments,
  places: {
    public: {
      entries: [...]
    },
    modules: {
      entries: [...]
    }
  }
}

Snapshot keyed by Place name.

Raw source хранится один раз.
Typed companions рядом с raw.
Domain policies берутся из resolved config, не дублируются в snapshot.

Disk/node-default/memory не передают entries.
Memory создаётся empty per thread.
Все configured Places регистрируются в worker независимо от presence snapshot entries.

Одна watcher epoch формирует одно message:

{
  name: 'vfs-update',
  updateId,
  places: {
    public: {
      entries: [...],
      removals: [...]
    },
    modules: {
      entries: [...],
      removals: [...]
    }
  },
  newSegments: [...]
}

Worker:
1. registers segments;
2. synchronously applies all Place updates;
3. sends one ack-update.

Old allocations freed only after all live workers ACK this updateId or exit.

ACK means worker projection switched to new entries. It does not track previously returned public direct views.

==================================================
29. WATCHER PIPELINE
==================================================

Выделить единый pipeline для:
- existing file change;
- new file;
- new directory subtree;
- deferred recheck.

Pipeline:
1. validate domain scan participation;
2. stable source read;
3. allocate raw;
4. build require bytecode when enabled and applicable;
5. build fs compression when enabled and applicable;
6. prepare entries/removals for one epoch.

New directory JS files must receive bytecode in same epoch.
New directory compressible files must receive representations in same epoch.

One failed source must not block other files of epoch.

If source stable but optional representation fails:
- publish source;
- publish successful representations;
- remove stale failed representations.

Deletion:
- remove source;
- remove all typed companions;
- one epoch;
- old allocations after ACK.

Automatically start watcher for any sab Place with fs.writable:true.

Read-only SAB watching may depend on global watch setting.

Eventual consistency is intentional:
- write may complete before SAB changes;
- delete may complete before SAB entry disappears;
- no waitForUpdate API now.

==================================================
30. COMPACTION
==================================================

Keep existing best-fit and segment reuse concepts.

Compaction:
- moves raw and all companion entry types alike;
- uses same vfs-update and one ACK;
- does not create new segments;
- rollback if all entries cannot be relocated;
- old segment not reusable before ACK;
- threshold 0 disabled.

Preliminary policy:
- at most one compaction operation per free cycle;
- no automatic recursive chain.

Add comment/TODO or design note that Opus/Fable should evaluate later whether scheduled compaction or repeated compaction to a target is preferable. Do not overengineer now.

Do not add allocation IDs or complex double-free tracking now.

Add tests ensuring:
- repeated ACK does not free twice;
- worker exit and ACK do not free twice;
- rollback allocation does not enter ACK cleanup;
- compaction waits for ACK.

==================================================
31. SINGLE BOOTSTRAP
==================================================

Delete preload.cjs completely:
- file;
- export path;
- docs;
- examples;
- tests tied to it.

Only supported bootstrap:

node --import shared-memory-fs/register app.js

register.mjs must before entry point:

1. load config;
2. create kernel;
3. await kernel.initialize();
4. install fs and require hooks;
5. register ESM loader;
6. start watcher if configured or required by writable SAB;
7. publish ready kernel;
8. allow entry point to run.

Public ready kernel:
globalThis.__vfsKernel

Do not publish a partially initialized kernel as public ready object.

If initialization or hook installation fails:
- entry point must not run;
- rollback installed fs/require hooks;
- close kernel;
- remove global reference;
- throw error.

Same bootstrap supports CJS and ESM entry points.

Disk/node-default never receive vfs: URL.

Memory-backed entry point is not promised.

Test whether SAB/SEA-backed entry points can actually be intercepted after --import registration. If Node chooses/resolves the entry point too early, document that entry point must be on disk while dependencies may live in VFS. Do not claim unsupported behavior.

==================================================
32. KERNEL LIFECYCLE
==================================================

Use explicit states:
- new
- initializing
- ready
- closed

initialize only from new.

During initializing:
- snapshot/watch/fs facade unavailable.

Success:
- ready.

Failure:
- closed;
- same kernel cannot be initialized again.

snapshot(), watch(), fs(name):
- only in ready state.

close():
- final;
- stop watcher;
- clear deferred work;
- clear maps;
- release large references where safe;
- no reinitialize.

Hooks are installed/uninstalled by bootstrap/runtime layer, not implicitly hidden inside close.

==================================================
33. CONFIG VALIDATION
==================================================

Maintain deep clone and deep freeze.

JS config booleans must be actual booleans.
Do not convert string "false" via Boolean("false").

CLI may explicitly parse "true"/"false".

Protect setNested from:
- __proto__
- prototype
- constructor

Compression validation:
- gzip 0..9
- deflate 0..9
- br 0..11
- zstd 1..22
- duplicate encodings invalid;
- options for unselected encoding invalid;
- unsupported option invalid;
- preserve native zlib defaults when options absent.

retainRaw:false incompatible with require.compile:true if compilation needs raw SAB source.

Validate provider/domain combinations described above.

Resolved config deeply frozen, including arrays and nested domain objects.

==================================================
34. TEST STRATEGY
==================================================

Do not merely adapt old tests until green. Add regression and architecture tests for every important contract.

At minimum cover:

Config:
- Place name validation;
- case-insensitive collision;
- removal of dir;
- domain shorthand/expanded forms;
- scanExt preinitialization;
- fs unrestricted scanExt null;
- provider/domain compatibility;
- disk explicit compile:false;
- writable validation;
- exposeSharedMemory validation;
- numeric validation;
- effective segment validation;
- deep freeze;
- no input mutation;
- CLI pollution protection.

Cache:
- extent rollback after writer error;
- full-read behavior;
- size > baseSegmentSize rejected;
- derived allocation fallback false;
- representation larger than segment skipped;
- compaction one per cycle;
- ACK/free correctness.

FS facade:
- kernel.fs errors;
- readFile owned copy;
- readFileView exposure policy;
- shared stream/copy stream modes;
- strict range checks;
- lazy VfsStats and BigInt;
- lazy VfsDirent;
- readdir direct and recursive;
- access/exists;
- memory write/append/unlink/mkdir/rm/rename;
- cross-Place rename EXDEV;
- read-only EROFS;
- unsupported ENOTSUP.

Strict:
- unpublished file inside SAB mount denied;
- excluded extension not revealed;
- disk Place managed passthrough;
- unknown mount under appRoot denied;
- outside appRoot passthrough;
- symlink rules.

Watcher:
- stable update;
- unstable source retains old version;
- one deferred recheck;
- no infinite retries;
- new directory with JS gets bytecode;
- new directory with compressed file gets representation;
- stale bytecode removed after failure;
- failed codec removes stale representation;
- one bad file does not block epoch;
- one vfs-update and one ACK.

CommonJS:
- cached data really accepted;
- throwing module executes once;
- damaged/rejected cache falls back once;
- module.loaded lifecycle;
- circular dependencies;
- exact path order;
- .js/.cjs/.json;
- package main and index;
- strict missing behavior.

ESM:
- real --import/module.register process test;
- file entry imports SAB module A;
- A imports B and B imports C;
- canonical vfs:file URL;
- special path characters;
- missing ERR_MODULE_NOT_FOUND;
- JSON attributes;
- repeated import executes once;
- disk remains file:;
- loader state transfer proven end to end.

Bootstrap:
- CJS entry;
- ESM entry;
- initialize completes before entry;
- initialization failure prevents entry execution;
- partial hooks rolled back;
- watcher starts for writable SAB;
- preload removed.

Documentation:
- README matches code;
- VFS.instructions.md rewritten to match final invariants;
- no claim of full node:fs compatibility;
- clearly list supported methods;
- explain eventual consistency;
- explain borrowed shared views;
- explain compile:true warning for mixed frontend/server Places;
- explain CJS bytecode versus ESM source sharing;
- explain Place key equals folder/mount.

==================================================
35. WORK PROCESS
==================================================

Implement this as a coherent refactor, but use logical internal commits or phases if helpful.

Do not keep old architecture alive in parallel.

Prefer extracting small internal helpers over copying routing and watcher logic.

Before every verification command explicitly change to the repository root.

Determine the actual repository path first. Then use:

cd <repository-root>

Run focused tests during development, then the complete suite.

At the end run at minimum:

node --test

Also run lint and other package scripts defined in package.json.

If tests require child Node processes, ensure they terminate deterministically and do not leave watchers open.

Do not hide failing tests, skip tests, weaken assertions or change expected results merely to obtain green status.

If an external Node or metawatch limitation prevents an agreed behavior:
- demonstrate it with a focused test;
- implement the closest correct behavior;
- document the exact limitation;
- do not silently pretend support.

==================================================
36. FINAL REPORT
==================================================

After implementation report:

1. High-level architecture changes.
2. Files added, deleted and substantially rewritten.
3. Bugs definitively fixed.
4. Public config examples.
5. Public API examples.
6. Provider/domain behavior.
7. Snapshot/delta protocol.
8. Watcher eventual-consistency behavior.
9. Shared-memory exposure and lifetime contract.
10. CommonJS and ESM loader behavior.
11. Test counts and commands.
12. Any remaining limitations or deliberate non-goals.
13. Any points recommended for independent review by Opus/Fable, especially:
    - compaction scheduling;
    - Node internal CommonJS compatibility;
    - ESM loader realm/state transport;
    - direct-view lifetime documentation;
    - strict sandbox and symlink behavior.

Before coding, inspect the current implementation carefully and preserve good existing mechanisms where compatible:
- pooled SAB segments;
- best-fit extents;
- segment reuse;
- ACK-before-free;
- zero-copy internal projection;
- per-codec compression isolation;
- dependency injection between cache, module cache, compression cache and kernel.

Do not replace working low-level mechanisms merely because the public architecture changed.
