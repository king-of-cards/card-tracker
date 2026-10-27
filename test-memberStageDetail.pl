use strict;
use warnings;
use LWP::UserAgent;
use JSON;

my $ua  = LWP::UserAgent->new;
my $url = 'http://localhost:8080/api/memberStageDetail?division=KOC%20Cards';

my $response = $ua->get($url);

print "Status Code: ", $response->code, "\n";

if ($response->is_success) {
    my $data = decode_json($response->decoded_content);
    print "\n--- Pretty printed response ---\n";
    my $json = JSON->new->pretty->canonical;
    print $json->encode($data);
} else {
    print "Response Body:\n", $response->decoded_content, "\n";
}