Сравнил обе инструкции целиком. Итог: актуальная инструкция не ушла от первоначального замысла, а превратила его черновую Phase 1 архитектуру в более строгую и целостную систему. Основные инварианты сохранены, а наиболее крупные отклонения либо были нами сознательно приняты, либо обоснованы runtime-проверками Fable, Opus и Grok.

1. Что сохранилось из первоначальной задумки
Pooled SAB и zero-copy между workers

Изначально требовалось:

единый pooled SharedArrayBuffer;
worker получает Buffer.from(sab, offset, length);
данные файла не копируются отдельно в каждый worker;
пустые сегменты переиспользуются;
старые allocations не освобождаются до ACK workers.

В актуальной архитектуре это полностью сохранено. Уточнено только различие между внутренней zero-copy projection и публичным API:

внутри VFS:
  direct SAB views

публичный readFile:
  owned copy

публичный *View:
  borrowed SAB view только при fs.zeroCopy:true


Это укрепляет исходную модель, поскольку недоверенный пользовательский код больше не получает изменяемый SAB-view по умолчанию.

Frozen config

Изначальная инструкция требовала глубокого замораживания VfsConfig. Это сохранено и расширено: теперь замораживается также merged config.raw, который можно передать worker-у и заново нормализовать. Добавлена строгая проверка boolean, чисел и CLI prototype pollution.

ACK-before-free

Первоначальная идея была:

опубликовать новую entry
→ дождаться ACK всех workers
→ освободить старую


Она сохранена. Новая версия даже исправляет ранее неучтённый случай compaction: сегмент с удалёнными из индекса, но ещё ACK-pending bytes закрывается для allocation до окончательного освобождения. Это реальное усиление первоначального инварианта.

Source и companions обновляются совместно

Исходное правило No mixed versions сохранено и стало строже:

source;
bytecode;
compressed representations;
removals устаревших companions

публикуются одним vfs-update. Если companion не удалось перестроить, старая версия удаляется в той же epoch.

Cache остаётся изолированным от Node I/O

Первоначально cache.js должен был оставаться независимым от Node и получать reader через dependency injection. Актуальная инструкция сохраняет этот контракт. Дополнительно внутренние функции scanner/kernel/watcher деструктурируют настоящий node:fs, чтобы установленный sandbox patch не блокировал внутренние операции VFS.

2. Что существенно улучшено
Модель Place стала гораздо цельнее

Раньше:

{
  domains: ['fs', 'require', 'import'],
  dir: 'public',
  compile: true,
  compress: { ... }
}


Теперь:

places: {
  public: {
    provider: 'sab',

    fs: {
      writable: true,
      zeroCopy: false,
      compress: { ... },
    },

    require: {
      compile: true,
    },

    import: true,
  },
}


Имя Place теперь одновременно является:

логическим ID;
директорией;
mount;
cache namespace;
snapshot/delta key.

Это устранило расхождение name, dir, mount и filesystems[mount], которое было источником неоднозначной маршрутизации.

Домены не исчезли. Они стали полноценными секциями политики:

fs      → filesystem visibility, writes, compression, zeroCopy
require → CommonJS visibility и cached data
import  → ESM visibility


Raw source по-прежнему хранится один раз на Place. scanExt лишь объединяет потребности доменов для scanner, но каждый интерфейс повторно проверяет собственный ext. Это точно соответствует нашей согласованной модели.

Public Place разделён на storage и FS facade

Первоначальный Place одновременно был внутренней проекцией и публичным API. Теперь:

Place
→ внутреннее состояние и projection

PlaceFs
→ публичный kernel.fs(name)


Это позволило:

скрыть внутренние entries;
возвращать owned copies;
добавить VfsStats;
реализовать readdir;
применять writable и zero-copy policies;
не раскрывать bytecode через публичный Place.

Это хорошее архитектурное улучшение, а не уход от идеи.

Strict превратился в настоящий sandbox

В исходной инструкции strict практически не был формализован. Актуальная версия однозначно определяет:

appRoot = sandbox boundary

неопубликованный путь под индексируемым Place запрещён;
неизвестный mount под appRoot запрещён;
запрет действует на любой глубине;
guard распространяется на opendir, glob, cp, watch и другие пути обхода;
внешний путь остаётся passthrough;
disk является явно управляемым passthrough mount.

Это одно из главных улучшений относительно начальной архитектуры.

Worker integration стала конкретной

Раньше инструкция предполагала ручную передачу snapshot и ACK, но не описывала полноценный lifecycle worker. Теперь появились:

const { vfs, transferList } = kernel.link();


и:

const kernel = attach();


MessagePort передаёт snapshot, config, deltas и ACK, а закрытие порта учитывается как worker exit. Это развивает первоначальную worker-side projection, не меняя её фундаментальной модели.

3. Обоснованные изменения исходной техники
module.registerHooks() вместо двух loader-систем

Изначально использовались:

Module._resolveFilename
import-hook.mjs через module.register()


Теперь один synchronous in-thread module.registerHooks() обслуживает CJS и ESM resolution/load, а _compile остаётся только для V8 cached data. Это уменьшило monkey patching и устранило отдельный loader realm.

Это правильное современное направление, но оно обоснованно подняло минимальную версию Node до 22.22.3.

Обычные file: URL вместо vfs:

Первоначально ESM использовал custom vfs: URL. Новая реализация сохраняет обычный file: URL даже для memory/SAB source, а hook подменяет загрузку bytes. Благодаря этому естественно сохраняются:

import.meta.url;
__filename;
require.cache;
module identity.

Opus уже экспериментально проверил identity, вложенные imports и однократное выполнение. Поэтому отказ от vfs:file: является улучшением, а не потерей возможности.

DirWatcher вместо metawatch

Изначально watcher основывался на metawatch. Теперь используется собственный DirWatcher, потому что metawatch обращался к patched fs.stat и конфликтовал со strict sandbox. Новый watcher имеет epoch batching, deferred recheck и explicit close.

Поскольку Grok прогнал watcher-сценарии на WSL Linux, это изменение уже подтверждено не только Windows-тестами.

Размер сегмента больше не округляется автоматически

Изначальная формула:

baseSegmentSize =
  ceil(maxFileSize / configuredSegmentSize) * configuredSegmentSize


заменена строгим ограничением:

maxFileSize <= segmentSize <= limit


Это заметное изменение: раньше config мог автоматически увеличить реальный размер каждого сегмента, теперь пользователь обязан явно выбрать достаточный segmentSize.

На мой взгляд, новое правило лучше:

segmentSize теперь действительно означает фактический размер сегмента;
config не создаёт неожиданно более крупные SAB;
memory planning становится прозрачнее;
derived representation, не помещающееся в сегмент, просто пропускается.

Это соответствует решению, которое мы отдельно обсуждали.

4. Где актуальная инструкция немного ушла в детали реализации

Первоначальная инструкция завершалась правилом:

Не документировать implementation details, которые могут быстро измениться.

Новая инструкция местами очень подробна:

точное название private методов #refresh, #publish, #rescan;
конкретный алгоритм ep.seen;
точный набор return variants FsRouter;
детали makeRequireFunction;
техническая особенность V8 per-isolate cache;
точная структура MessagePort link.

Это не неправильная информация, но увеличивает вероятность drift. Я бы разделил документ:

В VFS.instructions.md оставить
архитектурные границы модулей;
публичные контракты;
security-инварианты;
ACK и memory ownership;
provider/domain semantics;
обязательные тестовые свойства.
В отдельный design document перенести
точные private method names;
внутренний watcher algorithm;
V8-specific testing instructions;
точную последовательность link port handling;
compaction implementation notes.

Это необязательная правка перед окончанием ветки, но полезна для дальнейшей поддержки.

5. Места, которые стоит уточнить
disk не должен называться storage с entries

Актуальная инструкция описывает disk/node-default → nothing при initialization и managed passthrough в routing. Это правильно.

В README таблица использует формулировку:

disk | OS path entries | metadata | managed passthrough


Она хуже инструкции и создаёт впечатление, что disk Place индексирует metadata. Лучше написать:

disk | OS filesystem passthrough | managed mount | no VFS index

open правильнее назвать recognized-but-unsupported

Инструкция относит open к implemented, но уточняет ENOTSUP on virtual entries.

Для пользователя это скорее:

routed and safely rejected for virtual files


чем реализованный open. В README лучше сделать три группы:

Implemented for virtual entries.
Recognized but unsupported, returns ENOTSUP.
Guarded passthrough APIs.
Публичный kernel.bytecode(absPath)

Актуальная инструкция говорит, что bytecode доступен через:

kernel.bytecode(absPath)


при этом публичный getCachedData() удалён.

Это не ломает архитектуру, но требует ответа:

Есть ли реальный публичный потребитель kernel.bytecode()?

Если этот метод нужен только module hook, его лучше сделать внутренним. Иначе пользователь получает borrowed bytecode Buffer, к которому должны применяться те же правила shared-memory exposure и lifetime.

config.raw как frozen и cloneable

Фраза:

config.raw — merged input, frozen and cloneable


нуждается в точной трактовке. Если config.raw реально frozen, worker должен получать structured clone, а не пытаться модифицировать объект. Это, судя по link(), так и задумано.

6. Lockfile metautil

Это сейчас более практический риск, чем архитектурный drift.

Grok сообщил:

lockfile metautil = git+ssh
CI rewrite на HTTPS


Так оставлять не стоит. Package и lock должны быть воспроизводимы без CI-specific переписывания.

Нужно добиться, чтобы и package.json, и package-lock.json использовали доступный без SSH-ключа GitHub URL с закреплённым SHA. CI не должен менять dependency source перед npm ci.

Проверь после последнего npm install:

cd ~/projects/shared-memory-fs
grep -n "metautil" package.json package-lock.json


И чистую установку:

cd ~/projects/shared-memory-fs
rm -rf node_modules
npm ci

Итоговый вердикт
Сохранено
общий raw storage Place;
SAB pool;
zero-copy worker projection;
frozen config;
ACK-before-free;
segment reuse;
source и companions одной версии;
bytecode и compression как derived representations;
worker snapshot/delta;
dependency injection;
отсутствие forced timeout free.
Улучшено обоснованно
Place/domain model;
публичный FS facade;
strict sandbox;
writable policy;
typed companions;
единая epoch;
registerHooks;
link()/attach();
stable source reads;
compaction safety;
explicit kernel lifecycle;
protected-by-default shared memory exposure.
Не вижу потери первоначальной архитектурной цели

Напротив, новая версия лучше соответствует исходному назначению: shared-memory VFS для workers с безопасным обновлением и прозрачными Node interfaces.

Перед финальным Opus review я бы сделал четыре вещи
Исправил HTTPS-воспроизводимость зависимости metautil.
Уточнил таблицу disk в README.
Переклассифицировал open как safely recognized but unsupported.
Решил, является ли kernel.bytecode() публичным API или только internal hook API.

После этого Opus можно дать короткий финальный review в WSL, уже не про пересмотр всей архитектуры, а про эти четыре пункта, CI workflow и соответствие README фактическому коду.
