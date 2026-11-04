<?php
declare(strict_types=1);
require __DIR__ . '/../public/api/relay-core.php';

use CypherTempre\FreeModels\{Policy, Store, Relay, RelayError, PendingOutput};

// Test children never inherit a real operator secret or secret-location override.
putenv('CHAINCHAT_OPENCODE_API_KEY'); putenv('CHAINCHAT_FREE_CONFIG_DIR');

$root = sys_get_temp_dir() . '/ct-free-relay-php-' . bin2hex(random_bytes(8));
mkdir($root, 0700);
$secret = 'oc_sk_synthetic_relay_fixture_0123456789012345';
$session = 'ab123456-ab12-4b12-ab12-ab1234567890';
$passed = 0; $failed = 0; $skips = [];
function ok(bool $condition): void { if (!$condition) throw new RuntimeException('Assertion failed.'); }
function denied(callable $action, ?string $code = null): void {
    try { $action(); } catch (Throwable $error) {
        if ($code !== null && (!$error instanceof RelayError || $error->publicCode !== $code)) throw new RuntimeException('Wrong rejection code.');
        return;
    }
    throw new RuntimeException('Expected a held request.');
}
function run(string $label, callable $body): void {
    global $passed, $failed;
    try { $body(); $passed++; echo "PASS $label\n"; }
    catch (Throwable $error) { $failed++; echo "FAIL $label: " . get_class($error) . "\n"; }
}
function directory(): string { global $root; $path = $root . '/' . bin2hex(random_bytes(6)); mkdir($path, 0700); return $path; }
function model(string $id = 'beam-free', mixed $input = 0, mixed $output = 0): array {
    return ['id'=>$id, 'name'=>'Fixture model', 'api'=>['chat-completions'=>['base_url'=>Policy::BASE]],
        'cost'=>['text'=>['input'=>['price'=>$input,'cache'=>['read'=>0,'write'=>0]],'output'=>['price'=>$output]]],
        'modalities'=>['input'=>['text'],'output'=>['text']], 'limit'=>['context'=>131072,'output'=>8192],
        'capabilities'=>['reasoning'=>['supported'=>false]]];
}
function request(array $patch = []): array { return array_replace(['model'=>'beam-free','messages'=>[['role'=>'user','content'=>'Please respond carefully.']],'max_tokens'=>512], $patch); }
function response(string $text = 'A careful response.', mixed $cost = 0): string {
    return json_encode(['choices'=>[['message'=>['role'=>'assistant','content'=>$text], 'finish_reason'=>'stop']],
        'usage'=>['cost'=>$cost,'opencode'=>['list_cost'=>0]]], JSON_THROW_ON_ERROR);
}
function stream(array $texts, mixed $cost = 0, bool $done = true, bool $tool = false): string {
    $out = '';
    foreach ($texts as $text) {
        $delta = $tool ? ['tool_calls'=>[['index'=>0,'function'=>['arguments'=>$text]]]] : ['content'=>$text];
        $out .= 'data: ' . json_encode(['choices'=>[['index'=>0,'delta'=>$delta]]], JSON_THROW_ON_ERROR) . "\n\n";
    }
    $out .= 'data: ' . json_encode(['choices'=>[], 'usage'=>['cost'=>$cost,'opencode'=>['list_cost'=>0]]], JSON_THROW_ON_ERROR) . "\n\n";
    return $out . ($done ? "data: [DONE]\n\n" : '');
}

run('only known zero-priced text models at the exact upstream route are offered', function () {
    $valid = model();
    ok(count(Policy::models(['data'=>[$valid, model('iceman-contributor-free')]])) === 2);
    foreach ([model('paid-model'), model('beam-free', '0'), model('beam-free', 0, 1), model('beam-free', null)] as $bad) ok(Policy::models(['data'=>[$bad]]) === []);
    $bad = $valid; $bad['api']['chat-completions']['base_url'] = 'https://attacker.example/v1'; ok(Policy::models(['data'=>[$bad]]) === []);
    $bad = $valid; $bad['cost']['text']['input']['cache']['read'] = 1; ok(Policy::models(['data'=>[$bad]]) === []);
    $bad = $valid; $bad['modalities']['input'] = ['image']; ok(Policy::models(['data'=>[$bad]]) === []);
});
run('native function tools, text history and exact usage/output policy remain supported', function () {
    $body = request(['stream'=>true, 'stream_options'=>['include_usage'=>false], 'tools'=>[['type'=>'function','function'=>[
        'name'=>'read','description'=>'Read an approved file.','parameters'=>['type'=>'object','properties'=>['path'=>['type'=>'string']]]]]],
        'messages'=>[['role'=>'user','content'=>[['type'=>'text','text'=>'Read the fixture.']]],
            ['role'=>'assistant','content'=>null,'tool_calls'=>[['id'=>'call-1','type'=>'function','function'=>['name'=>'read','arguments'=>'{"path":"fixture"}']]]],
            ['role'=>'tool','tool_call_id'=>'call-1','content'=>'Blue.']], 'tool_choice'=>'auto']);
    $clean = Policy::request($body, Policy::models(['data'=>[model()]]));
    ok($clean['stream_options'] === ['include_usage'=>true] && $clean['max_tokens'] === 512);
});
run('native storage/cache hints are removed and paid service tiers remain forbidden', function () {
    $models=Policy::models(['data'=>[model()]]);
    $clean=Policy::request(request(['store'=>false,'prompt_cache_key'=>'synthetic-session-key','prompt_cache_retention'=>'24h',
        'prompt_cache_options'=>['ttl'=>'30m'],'service_tier'=>'auto']),$models);
    foreach (['store','prompt_cache_key','prompt_cache_retention','prompt_cache_options','service_tier'] as $field) ok(!array_key_exists($field,$clean));
    foreach ([['store'=>true],['service_tier'=>'priority'],['service_tier'=>'flex'],['prompt_cache_key'=>str_repeat('x',257)],
        ['prompt_cache_options'=>['ttl'=>'30m','paid'=>true]]] as $patch) denied(fn()=>Policy::request(request($patch),$models),'FREE_REQUEST_INVALID');
});
run('hosted tools, URLs, unknown fields, media and malformed tool roles are rejected', function () {
    $models = Policy::models(['data'=>[model()]]);
    foreach ([request(['url'=>'https://attacker.example']),request(['model'=>'paid-model']),
        request(['tools'=>[['type'=>'web_search']]]),request(['tool_choice'=>['type'=>'web_search']]),
        request(['messages'=>[['role'=>'user','content'=>'Text.','audio'=>[]]]]),
        request(['messages'=>[['role'=>'user','content'=>[['type'=>'image_url','image_url'=>['url'=>'https://example.com/a.png']]]]]]),
        request(['messages'=>[['role'=>'user','content'=>[['type'=>'text','text'=>'Text.','image_url'=>'hidden']]]]]),
        request(['messages'=>[['role'=>'user','content'=>'Text.','tool_calls'=>[]]]]),
        request(['messages'=>[['role'=>'tool','content'=>'Text.']]]),
        request(['response_format'=>['type'=>'audio']]),request(['temperature'=>INF]),request(['seed'=>'random']),
        request(['max_tokens'=>8193]),request(['max_tokens'=>127]),request(['stream'=>'true'])] as $bad) denied(fn()=>Policy::request($bad,$models));
});
run('plain JSON and completed SSE require explicit zero usage costs', function () use ($secret) {
    Policy::response(response(), 'application/json; charset=utf-8', $secret);
    Policy::response(stream(['A careful ', 'response.']), 'text/event-stream', $secret);
    foreach ([response('Text.',1), response('Text.',null), response('Text.','0'),
        json_encode(['choices'=>[],'usage'=>['opencode'=>['list_cost'=>0]]])] as $raw) denied(fn()=>Policy::response($raw,'application/json',$secret));
    $cost = json_decode(response(),true); $cost['usage']['opencode']['list_cost'] = 1;
    denied(fn()=>Policy::response(json_encode($cost),'application/json',$secret), 'FREE_PRICE_CHANGED');
    denied(fn()=>Policy::response(stream(['Text.'],0,false),'text/event-stream',$secret), 'FREE_RESPONSE_INVALID');
    denied(fn()=>Policy::response(response(),'text/plain',$secret), 'FREE_RESPONSE_INVALID');
});
run('full, encoded and fragmented content/tool-argument credentials never leave the relay', function () use ($secret) {
    foreach ([$secret,base64_encode($secret),bin2hex($secret),strtoupper(bin2hex($secret))] as $encoded) {
        denied(fn()=>Policy::response(response($encoded),'application/json',$secret), 'FREE_PRIVATE_DATA_HELD');
        $cut = (int)(strlen($encoded)/2);
        denied(fn()=>Policy::response(stream([substr($encoded,0,$cut),substr($encoded,$cut)]),'text/event-stream',$secret), 'FREE_PRIVATE_DATA_HELD');
        denied(fn()=>Policy::response(stream([substr($encoded,0,$cut),substr($encoded,$cut)],0,true,true),'text/event-stream',$secret), 'FREE_PRIVATE_DATA_HELD');
    }
    $escaped = str_replace($secret, '\\u006f' . substr($secret,1), response($secret));
    denied(fn()=>Policy::response($escaped,'application/json',$secret), 'FREE_PRIVATE_DATA_HELD');
});
run('response media and over-limit data are held', function () use ($secret) {
    $data = json_decode(response(),true); $data['choices'][0]['message']['audio'] = ['data'=>'media'];
    denied(fn()=>Policy::response(json_encode($data),'application/json',$secret), 'FREE_TEXT_ONLY');
    denied(fn()=>Policy::response(str_repeat('x',Policy::MAX_RESPONSE+1),'application/json',$secret), 'FREE_RESPONSE_LIMIT');
    denied(fn()=>Policy::request(request(['messages'=>[['role'=>'user','content'=>str_repeat('x',Policy::MAX_BODY)]]]),Policy::models(['data'=>[model()]])), 'FREE_INPUT_LIMIT');
});
run('HMAC quota state enforces client/global limits and releases concurrency leases', function () use ($secret) {
    $dir=directory(); $store=new Store($dir,$secret,2,3,1);
    $first=$store->reserve('192.0.2.1'); denied(fn()=>$store->reserve('192.0.2.2'),'FREE_RATE_LIMIT'); $store->release($first);
    $second=$store->reserve('192.0.2.1'); $store->release($second); denied(fn()=>$store->reserve('192.0.2.1'),'FREE_RATE_LIMIT');
    $third=$store->reserve('192.0.2.2'); $store->release($third); denied(fn()=>$store->reserve('192.0.2.3'),'FREE_RATE_LIMIT');
    $state=file_get_contents($dir.'/limits.json'); ok(!str_contains($state,'192.0.2.') && !str_contains($state,$secret));
    ok(json_decode($state,true)['leases'] === []);
});
run('expired leases and cooldowns are pruned without resetting request counters', function () use ($secret) {
    $dir=directory(); $store=new Store($dir,$secret,10,10,1); $lease=$store->reserve('192.0.2.4'); $store->block('beam-free');
    $state=json_decode(file_get_contents($dir.'/limits.json'),true); $state['leases'][$lease]['expires']=time()-1; $state['blocks']['beam-free']['expires']=time()-1;
    file_put_contents($dir.'/limits.json',json_encode($state)); ok($store->blocked() === []);
    $next=$store->reserve('192.0.2.4'); $store->release($next);
    $counts=array_column(json_decode(file_get_contents($dir.'/limits.json'),true)['buckets'],'count'); ok($counts === [2,2]);
});
run('corrupted quota files fail closed and retain their original bytes', function () use ($secret) {
    foreach (['','[]','{bad','{"buckets":"corrupt"}', '{"leases":{"wrong":{"expires":1}}}',
        json_encode(['buckets'=>[str_repeat('a',64)=>['count'=>'0','expires'=>time()+100]]]),
        json_encode(['blocks'=>['unknown-model'=>['expires'=>time()+100]]]),
        json_encode(['leases'=>[str_repeat('a',32)=>['expires'=>time()+10000]]])] as $raw) {
        $dir=directory(); file_put_contents($dir.'/limits.json',$raw); chmod($dir.'/limits.json',0600);
        $store=new Store($dir,$secret); denied(fn()=>$store->blocked()); ok(file_get_contents($dir.'/limits.json') === $raw);
    }
});
run('private permission policy refuses group/world accessible state', function () {
    Store::privatePermissions(0700); Store::privatePermissions(0600);
    foreach ([0701,0755,0770,0777,0644,0660] as $mode) denied(fn()=>Store::privatePermissions($mode),'FREE_SERVICE_UNAVAILABLE');
});
run('state/config symlinks and multiply linked state are not followed', function () use ($secret, &$skips) {
    $target=directory(); $link=directory().'/alias';
    if (@symlink($target,$link)) denied(fn()=>new Store($link,$secret),'FREE_SERVICE_UNAVAILABLE'); else $skips[]='Directory symlink creation unavailable on this Windows runtime.';
    $dir=directory(); $targetFile=$target.'/external.json'; file_put_contents($targetFile,'{"external":true}'); chmod($targetFile,0600);
    if (@symlink($targetFile,$dir.'/limits.json')) denied(fn()=>(new Store($dir,$secret))->blocked(),'FREE_SERVICE_UNAVAILABLE'); else $skips[]='File symlink creation unavailable on this Windows runtime.';
    $hardDir=directory();
    if (@link($targetFile,$hardDir.'/limits.json') && (lstat($targetFile)['nlink']??1)>1) denied(fn()=>(new Store($hardDir,$secret))->blocked(),'FREE_SERVICE_UNAVAILABLE');
    else $skips[]='Windows PHP does not expose a usable hard-link count; POSIX nlink policy remains enforced.';
    ok(file_get_contents($targetFile)==='{"external":true}');
});
run('private secret configuration must be outside webroot and is loaded without executing public files', function () use ($secret) {
    $site=directory(); mkdir($site.'/public',0700); mkdir($site.'/.chainchat-free',0700);
    file_put_contents($site.'/.chainchat-free/config.php','<?php return ["opencode_api_key"=>'.var_export($secret,true).'];'); chmod($site.'/.chainchat-free/config.php',0600);
    $_SERVER['DOCUMENT_ROOT']=$site.'/public'; putenv('CHAINCHAT_OPENCODE_API_KEY');
    ok(\CypherTempre\FreeModels\privateRelay() instanceof Relay);
});
run('atomic build document roots find the same private domain directory by bounded ancestry', function () use ($secret) {
    $site=directory(); $build=$site.'/.builds/hash/site'; mkdir($build,0700,true); mkdir($site.'/.chainchat-free',0700);
    file_put_contents($site.'/.chainchat-free/config.php','<?php return ["opencode_api_key"=>'.var_export($secret,true).'];'); chmod($site.'/.chainchat-free/config.php',0600);
    $selected=\CypherTempre\FreeModels\privateDirectory($build);
    ok($selected===realpath($site.'/.chainchat-free'));
    $store=new Store($selected,$secret); $lease=$store->reserve('192.0.2.12'); $store->release($lease);
    ok(is_file($site.'/.chainchat-free/limits.json') && !is_file($site.'/.builds/hash/.chainchat-free/limits.json'));
    $deep=$site.'/a/b/c/d/e/public_html'; mkdir($deep,0700,true);
    denied(fn()=>\CypherTempre\FreeModels\privateDirectory($deep),'FREE_SERVICE_UNAVAILABLE');
});
run('logical public_html aliases to atomic builds retain the private sibling configuration', function () use ($secret,&$skips) {
    $site=directory(); $build=$site.'/.builds/hash/site'; $alias=$site.'/public_html'; mkdir($build,0700,true); mkdir($site.'/.chainchat-free',0700);
    file_put_contents($site.'/.chainchat-free/config.php','<?php return ["opencode_api_key"=>'.var_export($secret,true).'];'); chmod($site.'/.chainchat-free/config.php',0600);
    $linked=@symlink($build,$alias);
    if (!$linked && PHP_OS_FAMILY==='Windows' && function_exists('proc_open')) {
        // A fixture-only NTFS junction exercises real alias resolution without elevation.
        $system=getenv('SystemRoot') ?: 'C:\\Windows';
        $process=@proc_open([$system.'\\System32\\cmd.exe','/d','/c','mklink','/J',str_replace('/','\\',$alias),str_replace('/','\\',$build)],
            [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,null,['SystemRoot'=>$system],['bypass_shell'=>true,'create_new_console'=>false]);
        if (is_resource($process)) { fclose($pipes[0]); stream_get_contents($pipes[1]); stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
            $linked=proc_close($process)===0 && realpath($alias)===realpath($build); }
    }
    if (!$linked) { $skips[]='Neither symlinks nor fixture-only junctions are supported; atomic ancestry case still executed.'; return; }
    try {
        ok(\CypherTempre\FreeModels\privateDirectory($alias)===realpath($site.'/.chainchat-free'));
        denied(fn()=>\CypherTempre\FreeModels\privateDirectory($alias,$alias.'/.chainchat-free',true),'FREE_SERVICE_UNAVAILABLE');
        denied(fn()=>\CypherTempre\FreeModels\privateDirectory($alias,$build.'/.chainchat-free',true),'FREE_SERVICE_UNAVAILABLE');
    } finally { if (PHP_OS_FAMILY==='Windows') rmdir($alias); else unlink($alias); }
});
run('only a trusted explicit private override can select a different outside-webroot location', function () use ($secret) {
    $site=directory(); mkdir($site.'/public_html',0700); mkdir($site.'/operator-private',0700);
    file_put_contents($site.'/operator-private/config.php','<?php return ["opencode_api_key"=>'.var_export($secret,true).'];'); chmod($site.'/operator-private/config.php',0600);
    ok(\CypherTempre\FreeModels\privateDirectory($site.'/public_html',$site.'/operator-private')===realpath($site.'/operator-private'));
    denied(fn()=>\CypherTempre\FreeModels\privateDirectory($site.'/public_html',$site.'/public_html/hidden',true),'FREE_SERVICE_UNAVAILABLE');
    denied(fn()=>\CypherTempre\FreeModels\privateDirectory($site.'/public_html','relative/private',true),'FREE_SERVICE_UNAVAILABLE');
    $_SERVER['DOCUMENT_ROOT']=$site.'/public_html'; putenv('CHAINCHAT_FREE_CONFIG_DIR='.$site.'/operator-private');
    try { ok(\CypherTempre\FreeModels\privateRelay() instanceof Relay); } finally { putenv('CHAINCHAT_FREE_CONFIG_DIR'); }
});
run('linked private configuration is rejected before any PHP configuration code executes', function () use ($secret,&$skips) {
    $site=directory(); mkdir($site.'/public_html',0700); mkdir($site.'/.chainchat-free',0700); $marker=$site.'/executed.txt';
    $outside=$site.'/outside.php'; file_put_contents($outside,'<?php file_put_contents('.var_export($marker,true).',"executed"); return ["opencode_api_key"=>'.var_export($secret,true).'];'); chmod($outside,0600);
    if (!@symlink($outside,$site.'/.chainchat-free/config.php')) { $skips[]='Private config symlink creation unavailable on this Windows runtime.'; return; }
    $_SERVER['DOCUMENT_ROOT']=$site.'/public_html';
    denied(fn()=>\CypherTempre\FreeModels\privateRelay(),'FREE_SERVICE_UNAVAILABLE'); ok(!file_exists($marker));
});
run('POSIX filesystem permissions and owner checks hold unsafe private paths', function () use ($secret,&$skips) {
    if (PHP_OS_FAMILY==='Windows') { $skips[]='Actual POSIX chmod/UID branches execute on required Linux CI; permission-mask tests execute locally.'; return; }
    $dir=directory(); chmod($dir,0777); denied(fn()=>new Store($dir,$secret),'FREE_SERVICE_UNAVAILABLE'); chmod($dir,0700);
    file_put_contents($dir.'/limits.json','{"buckets":[],"leases":[],"blocks":[]}'); chmod($dir.'/limits.json',0644);
    denied(fn()=>(new Store($dir,$secret))->blocked(),'FREE_SERVICE_UNAVAILABLE'); chmod($dir.'/limits.json',0600);
    $stat=lstat($dir); Store::privateOwner($stat); $stat['uid']++;
    denied(fn()=>Store::privateOwner($stat),'FREE_SERVICE_UNAVAILABLE');
});
run('each inference rechecks live zero pricing and never calls a paid or arbitrary route', function () use ($secret,$session) {
    $dir=directory(); $store=new Store($dir,$secret); $calls=[]; $price=0;
    $relay=new Relay($secret,$store,function($method,$url,$headers,$body,$timeout) use (&$calls,&$price) {
        $calls[]=[$method,$url];
        return ['status'=>200,'type'=>'application/json','body'=>$method==='GET'?json_encode(['data'=>[model('beam-free',0,$price)]]):response()];
    });
    ok($relay->infer(request(),'192.0.2.5',$session)['status']===200); $price=1;
    denied(fn()=>$relay->infer(request(),'192.0.2.5',$session),'FREE_MODEL_UNAVAILABLE');
    ok(count(array_filter($calls,fn($call)=>$call[0]==='POST'))===1 && count(array_filter($calls,fn($call)=>$call[0]==='GET'))===2);
    foreach ($calls as [$method,$url]) ok($url===($method==='GET'?Policy::CATALOGUE:Policy::BASE.'/chat/completions'));
    ok(json_decode(file_get_contents($dir.'/limits.json'),true)['leases']===[]);
});
run('invalid models, hosted tools, private data and sessions fail before upstream transport', function () use ($secret,$session) {
    $calls=0; $relay=new Relay($secret,new Store(directory(),$secret),function() use (&$calls) { $calls++; throw new RuntimeException('Must not run.'); });
    denied(fn()=>$relay->infer(request(['model'=>'paid-model']),'192.0.2.6',$session),'FREE_MODEL_UNAVAILABLE');
    denied(fn()=>$relay->infer(request(['tools'=>[['type'=>'web_search']]]),'192.0.2.6',$session),'FREE_FUNCTION_TOOLS_ONLY');
    denied(fn()=>$relay->infer(request(['messages'=>[['role'=>'user','content'=>$secret]]]),'192.0.2.6',$session),'FREE_PRIVATE_DATA_HELD');
    denied(fn()=>$relay->infer(request(),'192.0.2.6','invalid'),'FREE_SESSION_REQUIRED'); ok($calls===0);
});
run('upstream denial blocks the model temporarily, releases its lease and does not fall back', function () use ($secret,$session) {
    $dir=directory(); $store=new Store($dir,$secret); $posts=0;
    $relay=new Relay($secret,$store,function($method) use (&$posts) {
        if ($method==='POST') { $posts++; return ['status'=>403,'type'=>'application/json','body'=>'Never forwarded.']; }
        return ['status'=>200,'type'=>'application/json','body'=>json_encode(['data'=>[model()]])];
    });
    denied(fn()=>$relay->infer(request(),'192.0.2.7',$session),'FREE_MODEL_UNAVAILABLE');
    denied(fn()=>$relay->infer(request(),'192.0.2.7',$session),'FREE_MODEL_UNAVAILABLE');
    ok($posts===1 && in_array('beam-free',$store->blocked(),true)); ok(json_decode(file_get_contents($dir.'/limits.json'),true)['leases']===[]);
});
run('unknown/nonzero/fragmented upstream responses are held before client release and trigger cooldown', function () use ($secret,$session) {
    foreach ([['application/json',response('Text.',null)],['application/json',response('Text.',1)],
        ['text/event-stream',stream([substr($secret,0,12),substr($secret,12)])]] as [$type,$raw]) {
        $dir=directory(); $store=new Store($dir,$secret);
        $relay=new Relay($secret,$store,fn($method)=>['status'=>200,'type'=>$method==='GET'?'application/json':$type,
            'body'=>$method==='GET'?json_encode(['data'=>[model()]]):$raw]);
        denied(fn()=>$relay->infer(request(['stream'=>$type==='text/event-stream']),'192.0.2.8',$session));
        ok(in_array('beam-free',$store->blocked(),true)); ok(json_decode(file_get_contents($dir.'/limits.json'),true)['leases']===[]);
    }
});
run('the public session becomes a stable provider HMAC UUID and the private key stays in outbound headers', function () use ($secret,$session) {
    $headers=[]; $bodies=[];
    $relay=new Relay($secret,new Store(directory(),$secret),function($method,$url,$h,$body) use (&$headers,&$bodies) {
        if ($method==='POST') { $headers[]=$h; $bodies[]=$body; }
        return ['status'=>200,'type'=>'application/json','body'=>$method==='GET'?json_encode(['data'=>[model()]]):response()];
    });
    $relay->infer(request(),'192.0.2.9',$session); $relay->infer(request(),'192.0.2.10',$session);
    $first=array_values(array_filter($headers[0],fn($h)=>str_starts_with($h,'x-opencode-session: ')))[0];
    $second=array_values(array_filter($headers[1],fn($h)=>str_starts_with($h,'x-opencode-session: ')))[0];
    ok($first===$second && !str_contains($first,$session)); ok(in_array('Authorization: Bearer '.$secret,$headers[0],true));
    foreach ($bodies as $body) ok(!str_contains($body,$secret));
});
run('validated empty JSON objects in tool schemas keep object semantics on the upstream wire', function () use ($secret,$session) {
    $raw='{"model":"beam-free","messages":[{"role":"user","content":"Please respond."}],"max_completion_tokens":512,"tools":[{"type":"function","function":{"name":"noop","parameters":{"type":"object","properties":{}}}}]}';
    $wire=null; $relay=new Relay($secret,new Store(directory(),$secret),function($method,$url,$headers,$body) use (&$wire) {
        if ($method==='POST') $wire=$body;
        return ['status'=>200,'type'=>'application/json','body'=>$method==='GET'?json_encode(['data'=>[model()]]):response()];
    });
    $relay->infer(json_decode($raw,true),'192.0.2.11',$session,$raw);
    $decoded=json_decode($wire); ok($decoded->tools[0]->function->parameters->properties instanceof stdClass);
    ok($decoded->max_tokens===512 && !isset($decoded->max_completion_tokens));
    denied(fn()=>$relay->infer(request(),'192.0.2.11',$session,$raw),'FREE_REQUEST_INVALID');
});

run('pending transport emits only bounded constant protocol padding on a monotonic twelve-second throttle', function () {
    foreach ([false,true] as $stream) {
        $clock=100.0; $writes=[]; $starts=[]; $flushes=0;
        $pending=new PendingOutput($stream, function() use (&$clock) { return $clock; },
            function($bytes) use (&$writes) { $writes[]=$bytes; }, function() use (&$flushes) { $flushes++; },
            function($value) use (&$starts) { $starts[]=$value; });
        $pending->pulse(); $clock=111.999; $pending->pulse(); ok(!$pending->started() && $writes===[]);
        $clock=112; $pending->pulse(); $pending->pulse(); $clock=113; $pending->pulse();
        ok($pending->started() && $starts===[$stream] && count($writes)===1 && $flushes===1);
        ok(strlen($writes[0])===4096);
        ok($stream ? preg_match('/^: pending +\n\n$/D',$writes[0])===1 : preg_match('/^ +\n$/D',$writes[0])===1);
        for ($i=2;$i<=20;$i++) { $clock=100+12*$i; $pending->pulse(); }
        ok(count($writes)===PendingOutput::MAX_PULSES && $flushes===PendingOutput::MAX_PULSES);
        ok(count(array_unique($writes))===1 && count($starts)===1);
    }
});
run('invalid requests, changed pricing and exhausted quotas cannot start pending output', function () use ($secret,$session) {
    foreach (['invalid','price','quota'] as $mode) {
        $writes=[]; $starts=0; $posts=0; $store=new Store(directory(),$secret,1);
        if ($mode==='quota') { $lease=$store->reserve('192.0.2.20'); $store->release($lease); }
        $pending=new PendingOutput(false,fn()=>100.0,function($bytes) use (&$writes) { $writes[]=$bytes; },fn()=>null,
            function() use (&$starts) { $starts++; });
        $relay=new Relay($secret,$store,function($method,$url,$headers,$body,$timeout,$progress=null) use ($mode,&$posts) {
            if ($method==='POST') { $posts++; $progress(); return ['status'=>200,'type'=>'application/json','body'=>response()]; }
            ok($progress===null);
            return ['status'=>200,'type'=>'application/json','body'=>json_encode(['data'=>[model('beam-free',0,$mode==='price'?1:0)]])];
        });
        denied(fn()=>$relay->infer(request($mode==='invalid'?['model'=>'paid-model']:[]),'192.0.2.20',$session,null,$pending->pulse(...)));
        ok(!$pending->started() && $writes===[] && $starts===0 && $posts===0);
    }
});
run('slow approved JSON and SSE emit no candidate until whole-response policy approval', function () use ($secret,$session) {
    foreach ([false,true] as $stream) {
        $clock=0.0; $out=''; $starts=[];
        $pending=new PendingOutput($stream,function() use (&$clock) { return $clock; },function($bytes) use (&$out) { $out.=$bytes; },fn()=>null,
            function($value) use (&$starts) { $starts[]=$value; });
        $type=$stream?'text/event-stream':'application/json'; $raw=$stream?stream(['APPROVED_CANDIDATE']):response('APPROVED_CANDIDATE');
        $relay=new Relay($secret,new Store(directory(),$secret),function($method,$url,$headers,$body,$timeout,$progress=null) use (&$clock,&$out,$type,$raw) {
            if ($method==='GET') { ok($timeout===8 && $progress===null); return ['status'=>200,'type'=>'application/json','body'=>json_encode(['data'=>[model()]])]; }
            ok($timeout===115 && is_callable($progress));
            foreach ([12,24,36] as $time) { $clock=$time; $progress(); ok(!str_contains($out,'CANDIDATE')); }
            return ['status'=>200,'type'=>$type,'body'=>$raw];
        });
        $result=$relay->infer(request(['stream'=>$stream]),'192.0.2.21',$session,null,$pending->pulse(...));
        ok(!str_contains($out,'CANDIDATE') && $starts===[$stream]); $pending->complete($result);
        ok(str_ends_with($out,$raw));
        if (!$stream) ok(json_decode($out,true,64,JSON_THROW_ON_ERROR)['choices'][0]['message']['content']==='APPROVED_CANDIDATE');
    }
});
run('late cost, private-key, incomplete-stream and transport failures emit matching terminal errors without candidate bytes', function () use ($secret,$session) {
    foreach ([false,true] as $stream) foreach (['cost','unknown','secret','incomplete','transport'] as $mode) {
        $clock=0.0; $out='';
        $pending=new PendingOutput($stream,function() use (&$clock) { return $clock; },function($bytes) use (&$out) { $out.=$bytes; },fn()=>null,fn()=>null);
        $candidate=$mode==='secret'?$secret:'REJECTED_CANDIDATE';
        $cost=$mode==='cost'?1:($mode==='unknown'?null:0);
        $raw=$stream?stream([$candidate],$cost,$mode!=='incomplete'):response($candidate,$cost);
        $relay=new Relay($secret,new Store(directory(),$secret),function($method,$url,$headers,$body,$timeout,$progress=null) use (&$clock,$stream,$mode,$raw) {
            if ($method==='GET') return ['status'=>200,'type'=>'application/json','body'=>json_encode(['data'=>[model()]])];
            $clock=12; $progress();
            if ($mode==='transport') throw new RelayError('FREE_PROVIDER_UNAVAILABLE');
            return ['status'=>200,'type'=>$stream?'text/event-stream':'application/json','body'=>$raw];
        });
        $caught=null;
        try { $result=$relay->infer(request(['stream'=>$stream]),'192.0.2.22',$session,null,$pending->pulse(...));
            // A JSON fixture has no SSE terminator requirement; all other cases must be held.
            ok(!$stream && $mode==='incomplete'); $pending->complete($result); continue;
        } catch (RelayError $error) { $caught=$error; }
        ok($caught!==null && $pending->started()); $pending->fail(['error'=>['code'=>$caught->publicCode]]);
        ok(!str_contains($out,$candidate) && !str_contains($out,$secret));
        if ($stream) {
            $data=[]; foreach (explode("\n",$out) as $line) if (str_starts_with($line,'data: ')) $data[]=substr($line,6);
            ok(count($data)===2 && $data[1]==='[DONE]' && isset(json_decode($data[0],true,64,JSON_THROW_ON_ERROR)['error']['code']));
        } else ok(isset(json_decode($out,true,64,JSON_THROW_ON_ERROR)['error']['code']));
    }
});
run('fast responses and preflight errors retain ordinary JSON without pending headers or padding', function () {
    $out=''; $begins=0; $pending=new PendingOutput(true,fn()=>0.0,function($bytes) use (&$out) { $out.=$bytes; },fn()=>null,
        function() use (&$begins) { $begins++; });
    $pending->fail(['error'=>['code'=>'FREE_REQUEST_INVALID']]);
    ok(!$pending->started() && $begins===0 && json_decode($out,true,64,JSON_THROW_ON_ERROR)['error']['code']==='FREE_REQUEST_INVALID');
});

function cleanup(string $path): void {
    if (is_link($path) || !is_dir($path)) { unlink($path); return; }
    foreach (scandir($path) as $name) if ($name!=='.' && $name!=='..') cleanup($path.DIRECTORY_SEPARATOR.$name);
    rmdir($path);
}
$realRoot=realpath($root); $realTemp=realpath(sys_get_temp_dir());
ok($realRoot!==false && $realTemp!==false && str_starts_with($realRoot,$realTemp.DIRECTORY_SEPARATOR) && str_starts_with(basename($realRoot),'ct-free-relay-php-'));
cleanup($realRoot);
echo json_encode(['tests'=>$passed+$failed,'pass'=>$passed,'fail'=>$failed,'platformNotes'=>$skips],JSON_THROW_ON_ERROR) . "\n";
exit($failed===0?0:1);
