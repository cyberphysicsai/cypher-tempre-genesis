<?php
declare(strict_types=1);

namespace CypherTempre\FreeModels;

/** Hosted free-only transport. No provider credential is sent to a client. */
final class RelayError extends \RuntimeException {
    public function __construct(public readonly string $publicCode, public readonly int $status = 503) {
        parent::__construct($publicCode);
    }
}

final class Policy {
    public const CATALOGUE = 'https://opencode.ai/inference/go/v1/models';
    public const BASE = 'https://opencode.ai/inference/go/openai/v1';
    public const IDS = ['beam-free', 'iceman-contributor-free'];
    public const MAX_BODY = 2097152;
    public const MAX_RESPONSE = 4194304;
    public static function zero(mixed $n): bool {
        return (is_int($n) || is_float($n)) && is_finite((float)$n) && (float)$n === 0.0;
    }
    public static function models(array $catalogue): array {
        $out = [];
        $records = $catalogue['data'] ?? [];
        if (!is_array($records) || !array_is_list($records) || count($records) > 2000) return [];
        foreach ($records as $raw) {
            if (!is_array($raw) || !in_array($raw['id'] ?? '', self::IDS, true) ||
                !self::zero($raw['cost']['text']['input']['price'] ?? null) ||
                !self::zero($raw['cost']['text']['output']['price'] ?? null) ||
                ($raw['api']['chat-completions']['base_url'] ?? '') !== self::BASE ||
                !is_array($raw['modalities']['input'] ?? null) || !in_array('text', $raw['modalities']['input'], true) ||
                !is_array($raw['modalities']['output'] ?? null) || !in_array('text', $raw['modalities']['output'], true)) continue;
            foreach (['read', 'write'] as $cache) {
                if (isset($raw['cost']['text']['input']['cache'][$cache]) && !self::zero($raw['cost']['text']['input']['cache'][$cache])) continue 2;
            }
            $id = $raw['id'];
            $out[$id] = ['id' => $id, 'name' => substr((string)($raw['name'] ?? $id), 0, 160),
                'free' => true, 'pricing' => ['input' => 0, 'output' => 0], 'available' => true,
                'provider' => 'compatible', 'reasoningCapable' => ($raw['capabilities']['reasoning']['supported'] ?? false) === true,
                'contextWindow' => min(131072, max(4096, (int)($raw['limit']['context'] ?? 4096))),
                'maxOutputTokens' => min(8192, max(128, (int)($raw['limit']['output'] ?? 8192))),
                'privacyNotice' => $id === 'beam-free'
                    ? 'Requests and relevant chain context pass through Cypher Tempre to OpenCode. Beam does not train on prompts; its provider retains them for 30 days for safety. Regional restrictions apply.'
                    : 'Contributor model: requests and relevant chain context pass through Cypher Tempre to OpenCode and may be collected to improve the model. Choose your own API for a different data policy.'];
        }
        return $out;
    }
    private static function fields(array $value, array $allowed): void {
        foreach (array_keys($value) as $key) if (!in_array($key, $allowed, true)) throw new RelayError('FREE_REQUEST_INVALID', 400);
    }
    private static function name(mixed $value, int $maximum = 128): bool {
        return is_string($value) && strlen($value) <= $maximum && preg_match('/^[A-Za-z0-9_.:-]+$/D', $value) === 1;
    }
    private static function tools(mixed $tools): void {
        if (!is_array($tools) || !array_is_list($tools) || count($tools) > 128) throw new RelayError('FREE_REQUEST_INVALID', 400);
        foreach ($tools as $tool) {
            if (!is_array($tool) || ($tool['type'] ?? '') !== 'function' || !is_array($tool['function'] ?? null)) throw new RelayError('FREE_FUNCTION_TOOLS_ONLY', 400);
            self::fields($tool, ['type', 'function']); $function = $tool['function'];
            self::fields($function, ['name', 'description', 'parameters', 'strict']);
            if (!self::name($function['name'] ?? null) || isset($function['description']) && !is_string($function['description']) ||
                isset($function['parameters']) && !is_array($function['parameters']) ||
                isset($function['strict']) && !is_bool($function['strict'])) throw new RelayError('FREE_REQUEST_INVALID', 400);
        }
    }
    public static function request(array $body, array $models): array {
        if (strlen(json_encode($body, JSON_THROW_ON_ERROR)) > self::MAX_BODY) throw new RelayError('FREE_INPUT_LIMIT', 413);
        $id = $body['model'] ?? '';
        if (!is_string($id) || !isset($models[$id])) throw new RelayError('FREE_MODEL_UNAVAILABLE', 409);
        $allowed = ['model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'tools', 'tool_choice',
            'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'reasoning_effort', 'response_format', 'parallel_tool_calls',
            'store', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'service_tier'];
        self::fields($body, $allowed);
        // Native OpenClaw can emit these OpenAI transport hints automatically.
        // They never enable storage, extra retention or paid priority on the shared relay.
        if (array_key_exists('store',$body) && $body['store'] !== false) throw new RelayError('FREE_REQUEST_INVALID',400);
        if (isset($body['prompt_cache_key']) && (!is_string($body['prompt_cache_key']) || strlen($body['prompt_cache_key']) > 256 ||
            preg_match('/[\x00-\x1f\x7f]/',$body['prompt_cache_key']))) throw new RelayError('FREE_REQUEST_INVALID',400);
        if (isset($body['prompt_cache_retention']) && !in_array($body['prompt_cache_retention'],['in_memory','in-memory','24h'],true)) throw new RelayError('FREE_REQUEST_INVALID',400);
        if (isset($body['prompt_cache_options']) && (!is_array($body['prompt_cache_options']) || $body['prompt_cache_options'] !== ['ttl'=>'30m'])) throw new RelayError('FREE_REQUEST_INVALID',400);
        if (isset($body['service_tier']) && !in_array($body['service_tier'],['auto','default','standard'],true)) throw new RelayError('FREE_REQUEST_INVALID',400);
        unset($body['store'],$body['prompt_cache_key'],$body['prompt_cache_retention'],$body['prompt_cache_options'],$body['service_tier']);
        if (isset($body['tools'])) self::tools($body['tools']);
        if (!isset($body['messages']) || !is_array($body['messages']) || !array_is_list($body['messages']) ||
            count($body['messages']) < 1 || count($body['messages']) > 200) throw new RelayError('FREE_REQUEST_INVALID', 400);
        foreach ($body['messages'] as $m) {
            if (!is_array($m) || !in_array($m['role'] ?? '', ['system', 'developer', 'user', 'assistant', 'tool'], true)) throw new RelayError('FREE_REQUEST_INVALID', 400);
            self::fields($m, ['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
            if (isset($m['name']) && !self::name($m['name'])) throw new RelayError('FREE_REQUEST_INVALID', 400);
            if ($m['role'] === 'tool' ? !self::name($m['tool_call_id'] ?? null, 256) : array_key_exists('tool_call_id', $m)) throw new RelayError('FREE_REQUEST_INVALID', 400);
            if (array_key_exists('tool_calls', $m)) {
                if ($m['role'] !== 'assistant' || !is_array($m['tool_calls']) || !array_is_list($m['tool_calls']) ||
                    count($m['tool_calls']) < 1 || count($m['tool_calls']) > 128) throw new RelayError('FREE_REQUEST_INVALID', 400);
                foreach ($m['tool_calls'] as $call) {
                    if (!is_array($call) || ($call['type'] ?? '') !== 'function' || !self::name($call['id'] ?? null, 256) ||
                        !is_array($call['function'] ?? null) || !self::name($call['function']['name'] ?? null) ||
                        !is_string($call['function']['arguments'] ?? null)) throw new RelayError('FREE_REQUEST_INVALID', 400);
                    self::fields($call, ['id', 'type', 'function']); self::fields($call['function'], ['name', 'arguments']);
                }
            }
            $content = $m['content'] ?? null;
            if (is_array($content)) {
                if (!array_is_list($content)) throw new RelayError('FREE_TEXT_ONLY', 400);
                foreach ($content as $part) {
                if (!is_array($part) || ($part['type'] ?? '') !== 'text' || !is_string($part['text'] ?? null)) throw new RelayError('FREE_TEXT_ONLY', 400);
                    self::fields($part, ['type', 'text']);
                }
            }
            elseif (!is_string($content) && !($content === null && $m['role'] === 'assistant' && isset($m['tool_calls']))) throw new RelayError('FREE_TEXT_ONLY', 400);
        }
        foreach (['temperature' => [0, 2], 'top_p' => [0, 1], 'frequency_penalty' => [-2, 2], 'presence_penalty' => [-2, 2]] as $field => [$low, $high]) {
            if (array_key_exists($field, $body) && ((!is_int($body[$field]) && !is_float($body[$field])) ||
                !is_finite((float)$body[$field]) || $body[$field] < $low || $body[$field] > $high)) throw new RelayError('FREE_REQUEST_INVALID', 400);
        }
        if (isset($body['seed']) && !is_int($body['seed']) || isset($body['parallel_tool_calls']) && !is_bool($body['parallel_tool_calls']) ||
            isset($body['reasoning_effort']) && !in_array($body['reasoning_effort'], ['none','minimal','low','medium','high','xhigh','max'], true)) throw new RelayError('FREE_REQUEST_INVALID', 400);
        if (isset($body['tool_choice'])) {
            if (is_string($body['tool_choice'])) {
                if (!in_array($body['tool_choice'], ['auto','none','required'], true)) throw new RelayError('FREE_REQUEST_INVALID', 400);
            } elseif (is_array($body['tool_choice'])) {
                self::fields($body['tool_choice'], ['type','function']);
                if (($body['tool_choice']['type'] ?? '') !== 'function' || !is_array($body['tool_choice']['function'] ?? null) ||
                    !self::name($body['tool_choice']['function']['name'] ?? null)) throw new RelayError('FREE_FUNCTION_TOOLS_ONLY', 400);
                self::fields($body['tool_choice']['function'], ['name']);
            } else throw new RelayError('FREE_REQUEST_INVALID', 400);
        }
        if (isset($body['response_format'])) {
            if (!is_array($body['response_format'])) throw new RelayError('FREE_REQUEST_INVALID', 400);
            self::fields($body['response_format'], ['type', 'json_schema']);
            if (!in_array($body['response_format']['type'] ?? '', ['text','json_object','json_schema'], true)) throw new RelayError('FREE_REQUEST_INVALID', 400);
            if ($body['response_format']['type'] === 'json_schema') {
                $schema = $body['response_format']['json_schema'] ?? null;
                if (!is_array($schema) || !self::name($schema['name'] ?? null, 64) || !is_array($schema['schema'] ?? null) ||
                    isset($schema['strict']) && !is_bool($schema['strict']) || isset($schema['description']) && !is_string($schema['description'])) throw new RelayError('FREE_REQUEST_INVALID', 400);
                self::fields($schema, ['name','schema','strict','description']);
            } elseif (array_key_exists('json_schema', $body['response_format'])) throw new RelayError('FREE_REQUEST_INVALID', 400);
        }
        if (isset($body['stop'])) {
            $stops = is_string($body['stop']) ? [$body['stop']] : $body['stop'];
            if (!is_array($stops) || !array_is_list($stops) || count($stops) > 4) throw new RelayError('FREE_REQUEST_INVALID', 400);
            foreach ($stops as $stop) if (!is_string($stop) || strlen($stop) > 2048) throw new RelayError('FREE_REQUEST_INVALID', 400);
        }
        $budget = $body['max_completion_tokens'] ?? $body['max_tokens'] ?? 8192;
        if (!is_int($budget) || $budget < 128 || $budget > $models[$id]['maxOutputTokens']) throw new RelayError('FREE_OUTPUT_LIMIT', 400);
        if (isset($body['stream']) && !is_bool($body['stream'])) throw new RelayError('FREE_REQUEST_INVALID', 400);
        unset($body['max_completion_tokens']);
        $body['max_tokens'] = $budget;
        if (($body['stream'] ?? false) === true) $body['stream_options'] = ['include_usage' => true];
        else unset($body['stream_options']);
        return $body;
    }
    public static function isolate(string $secret, mixed $value): void {
        if (is_string($value)) {
            foreach ([$secret, rawurlencode($secret), base64_encode($secret), bin2hex($secret), strtoupper(bin2hex($secret))] as $form)
                if ($form !== '' && str_contains($value, $form)) throw new RelayError('FREE_PRIVATE_DATA_HELD');
        } elseif (is_array($value)) foreach ($value as $k => $v) { self::isolate($secret, (string)$k); self::isolate($secret, $v); }
    }
    public static function response(string $raw, string $type, string $secret): void {
        if (strlen($raw) > self::MAX_RESPONSE) throw new RelayError('FREE_RESPONSE_LIMIT');
        self::isolate($secret, $raw);
        $stream = str_contains(strtolower($type), 'text/event-stream');
        if (!$stream && !preg_match('~^application/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)~i', $type)) throw new RelayError('FREE_RESPONSE_INVALID');
        $priced = false; $channels = []; $documents = 0; $done = false;
        $consume = function (mixed $document) use ($secret, &$priced, &$channels, &$documents): void {
            if (!is_array($document) || ++$documents > 10000) throw new RelayError('FREE_RESPONSE_INVALID');
            self::isolate($secret, $document);
            if (isset($document['error'])) throw new RelayError('FREE_MODEL_UNAVAILABLE');
            if (isset($document['choices']) && !is_array($document['choices'])) throw new RelayError('FREE_RESPONSE_INVALID');
            foreach (($document['choices'] ?? []) as $choice) {
                if (!is_array($choice)) throw new RelayError('FREE_RESPONSE_INVALID');
                foreach (['delta','message'] as $field) if (isset($choice[$field])) {
                    $message = $choice[$field];
                    if (!is_array($message) || isset($message['content']) && !is_string($message['content']) ||
                        isset($message['audio']) || isset($message['images'])) throw new RelayError('FREE_TEXT_ONLY');
                }
            }
            $walk = function (mixed $value, string $path = '') use (&$walk, &$channels, $secret): void {
                if (is_array($value)) foreach ($value as $key => $child) $walk($child, $path . '/' . $key);
                elseif (is_string($value)) {
                    if (!array_key_exists($path, $channels) && count($channels) >= 4096) throw new RelayError('FREE_RESPONSE_LIMIT');
                    $joined = ($channels[$path] ?? '') . $value; self::isolate($secret, $joined);
                    $channels[$path] = substr($joined, -max(1, strlen($secret) * 2));
                }
            }; $walk($document);
            foreach ([['cost'], ['opencode', 'list_cost']] as $path) {
                $usage = $document['usage'] ?? [];
                foreach ($path as $key) {
                    if (!is_array($usage) || !array_key_exists($key, $usage)) continue 2;
                    $usage = $usage[$key];
                }
                if (!self::zero($usage)) throw new RelayError(is_int($usage) || is_float($usage) ? 'FREE_PRICE_CHANGED' : 'FREE_PRICE_UNVERIFIED');
                if ($path === ['cost']) $priced = true;
            }
        };
        if ($stream) {
            foreach (explode("\n", str_replace("\r\n", "\n", $raw)) as $line) {
                if (!str_starts_with($line, 'data:')) continue;
                $data = trim(substr($line, 5));
                if ($data === '') continue;
                if ($data === '[DONE]') { $done = true; continue; }
                if ($done) throw new RelayError('FREE_RESPONSE_INVALID');
                $consume(json_decode($data, true, 64, JSON_THROW_ON_ERROR));
            }
            if (!$done) throw new RelayError('FREE_RESPONSE_INVALID');
        } else $consume(json_decode($raw, true, 64, JSON_THROW_ON_ERROR));
        if (!$priced) throw new RelayError('FREE_PRICE_UNVERIFIED');
    }
}

/** Ephemeral quota state contains HMAC buckets and lease IDs, never prompts/IPs. */
final class Store {
    public function __construct(private string $directory, private string $secret, private int $perHour = 120,
        private int $globalDay = 2000, private int $concurrency = 3) {
        if ($perHour < 1 || $globalDay < 1 || $concurrency < 1) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        $this->directory = self::secureDirectory($directory);
    }
    public static function privatePermissions(int $mode): void {
        if (($mode & 0077) !== 0) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
    }
    public static function privateOwner(array $stat): void {
        if (PHP_OS_FAMILY === 'Windows') return;
        $expected = function_exists('posix_geteuid') ? posix_geteuid() : getmyuid();
        if (!is_int($stat['uid'] ?? null) || $stat['uid'] !== $expected) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
    }
    public static function secureDirectory(string $directory): string {
        if ($directory === '' || str_contains($directory, "\0") || is_link($directory)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        if (!is_dir($directory) && !@mkdir($directory, 0700, true)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        clearstatcache(true, $directory); $stat = @lstat($directory); $real = realpath($directory);
        if (!$real || !$stat || ($stat['mode'] & 0170000) !== 0040000 || is_link($directory)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        self::privateOwner($stat);
        if (PHP_OS_FAMILY !== 'Windows') self::privatePermissions($stat['mode']);
        return $real;
    }
    private function validateState(mixed $state, int $now): array {
        if (!is_array($state) || isset($state['version']) && $state['version'] !== 1 ||
            array_diff(array_keys($state), ['version','buckets','leases','blocks'])) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        $state['version'] = 1;
        foreach (['buckets', 'leases', 'blocks'] as $field) {
            $state[$field] ??= [];
            if (!is_array($state[$field])) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
            foreach ($state[$field] as $key => $value) {
                if (!is_string($key) || !is_array($value) || !is_int($value['expires'] ?? null) || $value['expires'] < 0 ||
                    array_diff(array_keys($value), $field === 'buckets' ? ['count','expires'] : ['expires'])) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
                if ($field === 'buckets') {
                    $global = preg_match('/^global:[0-9]{1,10}$/D', $key) === 1;
                    if (!$global && preg_match('/^[a-f0-9]{64}$/D', $key) !== 1 || !is_int($value['count'] ?? null) || $value['count'] < 0 ||
                        $value['count'] > ($global ? $this->globalDay : $this->perHour) || $value['expires'] > $now + 172800) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
                } elseif ($field === 'leases') {
                    if (preg_match('/^[a-f0-9]{32}$/D', $key) !== 1 || $value['expires'] > $now + 300) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
                } elseif (!in_array($key, Policy::IDS, true) || $value['expires'] > $now + 600) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
                if ($value['expires'] <= $now) unset($state[$field][$key]);
            }
        }
        if (count($state['buckets']) > $this->globalDay + 2 || count($state['leases']) > $this->concurrency || count($state['blocks']) > count(Policy::IDS)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        return $state;
    }
    private function transaction(callable $fn): mixed {
        // A private non-symlink directory keeps file creation and owner checks meaningful.
        if (self::secureDirectory($this->directory) !== $this->directory) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        $path = $this->directory . '/limits.json';
        clearstatcache(true, $path); $prior = @lstat($path);
        if ($prior !== false) {
            if (($prior['mode'] & 0170000) !== 0100000 || $prior['nlink'] !== 1 || is_link($path)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
            self::privateOwner($prior);
            if (PHP_OS_FAMILY !== 'Windows') self::privatePermissions($prior['mode']);
        }
        $handle = @fopen($path, 'c+');
        if (!$handle) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        if (!flock($handle, LOCK_EX)) { fclose($handle); throw new RelayError('FREE_SERVICE_UNAVAILABLE'); }
        try {
            $stat = fstat($handle);
            if (!$stat || ($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1 || $stat['size'] > 524288 ||
                $prior !== false && ($stat['dev'] !== $prior['dev'] || $stat['ino'] !== $prior['ino'])) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
            self::privateOwner($stat);
            if ($prior === false && !@chmod($path, 0600)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
            $raw = stream_get_contents($handle);
            if ($raw === false || strlen($raw) > 524288 || $raw === '' && $prior !== false || $raw !== '' && !str_starts_with(ltrim($raw), '{')) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
            $now = time();
            $state = $this->validateState($raw === '' ? [] : json_decode($raw, true, 64, JSON_THROW_ON_ERROR), $now);
            $result = $fn($state, $now);
            $encoded = json_encode($state, JSON_THROW_ON_ERROR);
            rewind($handle);
            if (!ftruncate($handle, 0) || fwrite($handle, $encoded) !== strlen($encoded) || !fflush($handle)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
            return $result;
        } finally { flock($handle, LOCK_UN); fclose($handle); }
    }
    public function reserve(string $ip): string {
        return $this->transaction(function (&$s, $now) use ($ip) {
            $hour = (int)floor($now / 3600); $day = (int)floor($now / 86400);
            $client = hash_hmac('sha256', $ip . ':' . $hour, $this->secret);
            $global = 'global:' . $day;
            if (count($s['leases']) >= $this->concurrency || ($s['buckets'][$client]['count'] ?? 0) >= $this->perHour ||
                ($s['buckets'][$global]['count'] ?? 0) >= $this->globalDay) throw new RelayError('FREE_RATE_LIMIT', 429);
            foreach ([[$client, ($hour + 1) * 3600], [$global, ($day + 1) * 86400]] as [$key, $expires])
                $s['buckets'][$key] = ['count' => ($s['buckets'][$key]['count'] ?? 0) + 1, 'expires' => $expires];
            $lease = bin2hex(random_bytes(16)); $s['leases'][$lease] = ['expires' => $now + 150];
            return $lease;
        });
    }
    public function release(string $lease): void { if (preg_match('/^[a-f0-9]{32}$/D', $lease) !== 1) throw new RelayError('FREE_SERVICE_UNAVAILABLE'); $this->transaction(function (&$s) use ($lease) { unset($s['leases'][$lease]); }); }
    public function block(string $model): void { if (!in_array($model, Policy::IDS, true)) throw new RelayError('FREE_SERVICE_UNAVAILABLE'); $this->transaction(function (&$s, $now) use ($model) { $s['blocks'][$model] = ['expires' => $now + 300]; }); }
    public function blocked(): array { return $this->transaction(fn(&$s) => array_keys($s['blocks'])); }
}

/** Transport liveness only: never receives any upstream content or private headers. */
final class PendingOutput {
    public const INTERVAL = 12;
    public const MAX_PULSES = 9; // The inference transport still has its independent 115-second deadline.
    private \Closure $clock;
    private \Closure $write;
    private \Closure $flush;
    private \Closure $begin;
    private float $last;
    private int $pulses = 0;
    private bool $started = false;
    public function __construct(private bool $stream, ?callable $clock = null, ?callable $write = null,
        ?callable $flush = null, ?callable $begin = null) {
        $this->clock = \Closure::fromCallable($clock ?? static fn() => hrtime(true) / 1e9);
        $this->write = \Closure::fromCallable($write ?? static function ($bytes) { echo $bytes; });
        $this->flush = \Closure::fromCallable($flush ?? static function () { flush(); });
        $this->begin = \Closure::fromCallable($begin ?? static function ($stream) {
            // Discard removable PHP buffers instead of flushing unknown buffered bytes.
            @ini_set('zlib.output_compression', '0'); @ini_set('output_buffering', '0');
            while (ob_get_level() > 0) { $level = ob_get_level(); @ob_end_clean(); if (ob_get_level() === $level) break; }
            header('Content-Type: ' . ($stream ? 'text/event-stream' : 'application/json'));
            header('Cache-Control: no-store, no-transform'); header('X-Accel-Buffering: no');
            // Finish validation and quota cleanup even when the peer disconnects; cURL aborts on its next progress tick.
            ignore_user_abort(true);
        });
        $this->last = ($this->clock)();
    }
    public function started(): bool { return $this->started; }
    public function pulse(): void {
        $now = ($this->clock)();
        if ($now - $this->last < self::INTERVAL || $this->pulses >= self::MAX_PULSES) return;
        if (!$this->started) { ($this->begin)($this->stream); $this->started = true; }
        $this->last = $now; $this->pulses++;
        // Constant 4 KiB protocol padding cannot expose candidate text, usage, identifiers or credentials.
        ($this->write)($this->stream ? ': pending' . str_repeat(' ', 4085) . "\n\n" : str_repeat(' ', 4095) . "\n");
        ($this->flush)();
    }
    public function complete(array $response): void {
        $type = $this->stream ? 'text/event-stream' : 'application/json';
        if (($response['type'] ?? null) !== $type || !is_string($response['body'] ?? null)) throw new RelayError('FREE_RESPONSE_INVALID');
        if (!$this->started) header('Content-Type: ' . $type);
        ($this->write)($response['body']);
    }
    public function fail(array $payload): void {
        $json = json_encode($payload, JSON_THROW_ON_ERROR);
        // Once a pending pulse commits HTTP 200, signal a terminal protocol error, never a successful empty answer.
        ($this->write)($this->started && $this->stream ? 'data: ' . $json . "\n\ndata: [DONE]\n\n" : $json);
    }
}

final class Relay {
    private \Closure $fetch;
    public function __construct(private string $secret, private Store $store, callable $fetch) { $this->fetch = \Closure::fromCallable($fetch); }
    private function models(): array {
        $r = ($this->fetch)('GET', Policy::CATALOGUE, ['Accept: application/json'], null, 8);
        if ($r['status'] !== 200) throw new RelayError('FREE_CATALOGUE_UNAVAILABLE');
        if (strlen($r['body']) > Policy::MAX_RESPONSE) throw new RelayError('FREE_CATALOGUE_UNAVAILABLE');
        Policy::isolate($this->secret, $r['body']);
        $decoded = json_decode($r['body'], true, 64, JSON_THROW_ON_ERROR);
        Policy::isolate($this->secret, $decoded);
        if (!is_array($decoded)) throw new RelayError('FREE_CATALOGUE_UNAVAILABLE');
        return Policy::models($decoded);
    }
    public function catalogue(): array {
        $models = $this->models();
        foreach ($this->store->blocked() as $id) if (isset($models[$id])) { $models[$id]['available'] = false; $models[$id]['reason'] = 'Temporarily unavailable from the shared provider.'; }
        return ['freeOnly' => true, 'available' => count(array_filter($models, fn($m) => $m['available'])) > 0,
            'notice' => 'Free model tier *when available. Shared limits apply; never falls back to a paid model. Your selected context passes through this relay to OpenCode.',
            'limits' => ['requestsPerHour' => 120, 'outputTokens' => 8192, 'textOnly' => true], 'models' => array_values($models)];
    }
    public function infer(array $body, string $ip, string $session, ?string $originalJson = null, ?callable $pending = null): array {
        if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i', $session)) throw new RelayError('FREE_SESSION_REQUIRED', 400);
        $original = $body; $wire = null;
        if ($originalJson !== null) {
            if (strlen($originalJson) > Policy::MAX_BODY || json_decode($originalJson, true, 64, JSON_THROW_ON_ERROR) !== $body)
                throw new RelayError('FREE_REQUEST_INVALID', 400);
            $wire = json_decode($originalJson, false, 64, JSON_THROW_ON_ERROR);
            if (!$wire instanceof \stdClass) throw new RelayError('FREE_REQUEST_INVALID', 400);
        }
        $known = array_fill_keys(Policy::IDS, ['maxOutputTokens' => 8192]);
        $body = Policy::request($body, $known); // Invalid models, hosted tools and media never reach an upstream endpoint.
        Policy::isolate($this->secret, $body);
        $lease = $this->store->reserve($ip);
        try {
            $body = Policy::request($body, $this->models()); // Re-read current pricing for EVERY inference; no stale paid fallback.
            if (in_array($body['model'], $this->store->blocked(), true)) throw new RelayError('FREE_MODEL_UNAVAILABLE', 409);
            // Keep original JSON object/list distinctions inside validated tool/response schemas.
            // Only the bounded output budget and usage flag are rewritten by policy.
            if ($wire !== null) {
                foreach (array_keys(get_object_vars($wire)) as $key) if (!array_key_exists($key, $body)) unset($wire->$key);
                foreach ($body as $key => $value) if (!array_key_exists($key, $original) || $original[$key] !== $value)
                    $wire->$key = json_decode(json_encode($value, JSON_THROW_ON_ERROR), false, 64, JSON_THROW_ON_ERROR);
            }
            $id = hash_hmac('sha256', $session, $this->secret);
            $uuid = substr($id,0,8).'-'.substr($id,8,4).'-4'.substr($id,13,3).'-a'.substr($id,17,3).'-'.substr($id,20,12);
            $r = ($this->fetch)('POST', Policy::BASE . '/chat/completions', ['Authorization: Bearer ' . $this->secret,
                'Content-Type: application/json', 'User-Agent: CypherTempre-ChainChat', 'x-opencode-session: ' . $uuid], json_encode($wire ?? $body, JSON_THROW_ON_ERROR), 115, $pending);
            if ($r['status'] < 200 || $r['status'] >= 300) {
                if (in_array($r['status'], [401,403,404], true)) $this->store->block($body['model']);
                throw new RelayError($r['status'] === 429 ? 'FREE_RATE_LIMIT' : 'FREE_MODEL_UNAVAILABLE', $r['status'] === 429 ? 429 : 503);
            }
            try {
                if (($body['stream'] ?? false) !== str_contains(strtolower($r['type']), 'text/event-stream')) throw new RelayError('FREE_RESPONSE_INVALID');
                Policy::response($r['body'], $r['type'], $this->secret);
            }
            catch (\Throwable $e) { $this->store->block($body['model']); throw $e; }
            return ['status' => 200, 'body' => $r['body'], 'type' => ($body['stream'] ?? false) ? 'text/event-stream' : 'application/json'];
        } finally { $this->store->release($lease); }
    }
}

function upstream(string $method, string $url, array $headers, ?string $body, int $timeout, ?callable $pending = null): array {
    if (!in_array($url, [Policy::CATALOGUE, Policy::BASE . '/chat/completions'], true) || !function_exists('curl_init')) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
    $curl = curl_init($url); $raw = '';
    curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => $timeout, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_WRITEFUNCTION => function ($c, $bytes) use (&$raw) { if (strlen($raw) + strlen($bytes) > Policy::MAX_RESPONSE) return 0; $raw .= $bytes; return strlen($bytes); }]);
    if ($pending !== null) curl_setopt_array($curl, [CURLOPT_NOPROGRESS => false,
        CURLOPT_XFERINFOFUNCTION => static function ($c, $downloadSize, $downloaded, $uploadSize, $uploaded) use ($pending) {
            $pending(); return connection_aborted() ? 1 : 0;
        }]);
    if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
    $ok = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE); $type = (string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
    curl_close($curl);
    if ($ok === false || $status < 100) throw new RelayError('FREE_PROVIDER_UNAVAILABLE');
    return ['status' => $status, 'type' => $type, 'body' => $raw];
}

function absolutePath(string $path): string {
    if ($path === '' || strlen($path) > 4096 || str_contains($path, "\0") ||
        str_starts_with($path, '\\\\') || str_starts_with($path, '//') ||
        PHP_OS_FAMILY !== 'Windows' && str_contains($path, '\\')) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
    $path = rtrim(str_replace('\\', '/', $path), '/');
    if (!preg_match('~^(?:[A-Za-z]:/|/)~D', $path) || preg_match('~(?:^|/)\.{1,2}(?:/|$)~D', $path)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
    return $path;
}
function outsideWebroots(string $directory, array $webroots): bool {
    $directory = absolutePath($directory);
    if (PHP_OS_FAMILY === 'Windows') $directory = strtolower($directory);
    foreach ($webroots as $root) {
        $root = absolutePath($root); if (PHP_OS_FAMILY === 'Windows') $root = strtolower($root);
        if ($directory === $root || str_starts_with($directory, $root . '/')) return false;
    }
    return true;
}
/** Server-owned paths only: no request/header/body value selects a private directory. */
function privateDirectory(string $documentRoot, ?string $configured = null, bool $environmentSecret = false): string {
    $logical = absolutePath($documentRoot); $resolved = realpath($logical);
    if (!$resolved || !is_dir($resolved)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
    $webroots = [$logical, absolutePath($resolved)]; $candidates = [];
    $explicit = $configured !== null && $configured !== '';
    if ($explicit) $candidates[] = absolutePath($configured);
    else {
        $parents = $webroots;
        // Atomic Git builds may place the real document root under .builds/hash.
        // Search only four bounded ancestor levels for the fixed app-owned name.
        for ($depth = 0; $depth < 4; $depth++) foreach ($parents as $index => $current) {
            $parent = str_replace('\\', '/', dirname($current));
            if ($parent === $current || $parent === '/' || preg_match('~^[A-Za-z]:/?$~D', $parent)) continue;
            $parents[$index] = $parent;
            $candidate = $parent . '/.chainchat-free';
            if (!in_array($candidate, $candidates, true)) $candidates[] = $candidate;
        }
    }
    $firstSafe = null;
    foreach ($candidates as $candidate) {
        if (!outsideWebroots($candidate, $webroots)) { if ($explicit) throw new RelayError('FREE_SERVICE_UNAVAILABLE'); continue; }
        $firstSafe ??= $candidate;
        if (is_link($candidate)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        $config = $candidate . '/config.php';
        if (!file_exists($config) && !is_link($config) && !$explicit) continue;
        if (!is_dir($candidate)) { if ($explicit && $environmentSecret) break; throw new RelayError('FREE_SERVICE_UNAVAILABLE'); }
        $real = realpath($candidate);
        if (!$real || !outsideWebroots($real, $webroots)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        return Store::secureDirectory($candidate);
    }
    if ($environmentSecret && $firstSafe !== null) {
        $directory = Store::secureDirectory($firstSafe);
        if (!outsideWebroots($directory, $webroots)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        return $directory;
    }
    throw new RelayError('FREE_SERVICE_UNAVAILABLE');
}

function privateRelay(): Relay {
    $secret = getenv('CHAINCHAT_OPENCODE_API_KEY') ?: '';
    $directory = privateDirectory($_SERVER['DOCUMENT_ROOT'] ?? '', getenv('CHAINCHAT_FREE_CONFIG_DIR') ?: null, $secret !== '');
    $config = $directory . '/config.php';
    if ($secret === '' && is_file($config)) {
        clearstatcache(true, $config);
        $stat = @lstat($config);
        $real = realpath($config);
        if (!$real || !$stat || is_link($config) || ($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1 ||
            dirname($real) !== $directory) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
        Store::privateOwner($stat);
        if (PHP_OS_FAMILY !== 'Windows') Store::privatePermissions($stat['mode']);
        $values = require $real; $secret = is_array($values) ? ($values['opencode_api_key'] ?? '') : '';
    }
    if (!is_string($secret) || !preg_match('/^[A-Za-z0-9_.-]{24,4096}$/', $secret)) throw new RelayError('FREE_SERVICE_UNAVAILABLE');
    return new Relay($secret, new Store($directory, $secret), __NAMESPACE__ . '\\upstream');
}

function serve(bool $catalogue): never {
    ini_set('display_errors', '0'); ini_set('log_errors', '0');
    header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff'); header('Content-Type: application/json');
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (in_array($origin, ['https://cyphertempre.ai','https://www.cyphertempre.ai','http://127.0.0.1:8790','http://localhost:8790'], true)) {
        header('Access-Control-Allow-Origin: ' . $origin); header('Vary: Origin');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, X-ChainChat-Session'); header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    } elseif ($origin !== '') { http_response_code(403); echo '{"error":{"code":"FREE_ORIGIN_DENIED"}}'; exit; }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
    $pending = null;
    try {
        if ($catalogue) {
            if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET','HEAD'], true)) throw new RelayError('FREE_METHOD_DENIED',405);
            echo json_encode(privateRelay()->catalogue(), JSON_THROW_ON_ERROR);
        } else {
            if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') throw new RelayError('FREE_METHOD_DENIED',405);
            if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) throw new RelayError('FREE_REQUEST_INVALID',415);
            if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > Policy::MAX_BODY) throw new RelayError('FREE_INPUT_LIMIT',413);
            $raw = file_get_contents('php://input', false, null, 0, Policy::MAX_BODY + 1);
            if ($raw === false || strlen($raw) > Policy::MAX_BODY) throw new RelayError('FREE_INPUT_LIMIT',413);
            $body = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
            if (!is_array($body)) throw new RelayError('FREE_REQUEST_INVALID',400);
            $pending = new PendingOutput(($body['stream'] ?? false) === true);
            $r = privateRelay()->infer($body, $_SERVER['REMOTE_ADDR'] ?? 'unknown', $_SERVER['HTTP_X_CHAINCHAT_SESSION'] ?? '', $raw, $pending->pulse(...));
            $pending->complete($r);
        }
    } catch (\Throwable $error) {
        $code = $error instanceof RelayError ? $error->publicCode : 'FREE_SERVICE_UNAVAILABLE';
        if (!$pending?->started()) http_response_code($error instanceof RelayError ? $error->status : 503);
        if ($catalogue) echo json_encode(['freeOnly'=>true,'available'=>false,'models'=>[], 'notice'=>'Shared free access is temporarily unavailable. Your own API remains available.','code'=>$code]);
        else {
            $payload = ['error'=>['code'=>$code,'message'=>'Free access is unavailable for this request. Choose another available free model or connect your own API. No paid fallback was used.']];
            if ($pending !== null) $pending->fail($payload); else echo json_encode($payload);
        }
    }
    exit;
}
