use strict;
use warnings;
use LWP::UserAgent;
use JSON;

my $ua  = LWP::UserAgent->new;
my $url = 'http://localhost:8080/api/setVendors';

my $payload = {
    "KOC Cards" => ["KOC"],
};

my $json_body = encode_json($payload);

my $response = $ua->post(
    $url,
    'Content-Type' => 'application/json',
    Content        => $json_body,
);

print "Status Code: ", $response->code, "\n";
print "Response Body:\n", $response->decoded_content, "\n";